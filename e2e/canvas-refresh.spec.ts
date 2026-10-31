import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 刷新之后画布视口落在同一个地方（canvas.spec「布局被记住」偶发失败的回归）。
 *
 * 根因：打开时的视口适配用「量出来的」卡片尺寸算包围盒，量没量到（没量到按估计高度 480，真实约 216）、
 * 会话历史回没回来（回来后卡片变高）全看时机，两次打开的居中能差 (480-216)/2 = 132px。
 * 现在只用位置 + 存下来的尺寸（没存就默认宽、估计高）算，同样的布局永远是同一个视口。
 * 这里用拖慢历史接口、CPU 降速去压那个时序（不保证在旧代码上必现，主要防回归）；每次重复都建自己的项目，可以 --repeat-each。
 */
async function sessionOnCanvas(page: Page, baseURL: string, tag: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-refresh-'));
  const name = `e2e 刷新 ${tag} ${Date.now().toString(36)}`;
  const project = (await (await page.request.post('/api/projects', { data: { name, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '刷新' }, headers })).json()) as { id: string };
  rmSync(dir, { recursive: true, force: true });
  const { id } = (await (await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers })).json()) as { id: string };
  const ended = async () => {
    const events = (await (await page.request.get(`/api/sessions/${id}/events`)).json()) as Array<{ kind?: string; event?: { kind?: string } }>;
    return events.filter((entry) => (entry.kind ?? entry.event?.kind) === 'ended').length;
  };
  // 目录删了，每问一句都很快落「失败」：攒几轮，让卡片的高度明显取决于历史
  for (let n = 1; n <= 3; n++) {
    const before = await ended();
    await page.request.post(`/api/sessions/${id}/prompt`, { data: { text: `第 ${n} 句`, attachments: [] }, headers });
    await expect.poll(ended, { timeout: 15_000 }).toBeGreaterThan(before);
  }
  return project;
}

const box = async (page: Page) => {
  const b = await page.locator('.react-flow__node-session').first().boundingBox();
  return b ? [Math.round(b.x), Math.round(b.y)] : null;
};

for (const [delay, cpu] of [[0, 1], [1500, 1], [0, 12], [0, 30]] as const) {
  test(`刷新后卡片在屏幕上的位置不变（历史接口延迟 ${delay}ms，CPU 降速 ${cpu}x）`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    const project = await sessionOnCanvas(page, baseURL!, `${delay}-${info.repeatEachIndex}`);
    await page.goto(`/#/p/${project.id}/canvas`);
    const card = page.locator('.react-flow__node-session').first();
    await expect(card.getByText('第 3 句').first()).toBeAttached({ timeout: 10_000 });
    // 打开后的适配要等尺寸稳定：先等它停下来
    let settled: number[] | null = null;
    await expect.poll(async () => {
      const now = await box(page);
      const same = JSON.stringify(now) === JSON.stringify(settled);
      settled = now;
      return same;
    }, { intervals: [300] }).toBe(true);

    if (delay > 0) {
      await page.route('**/api/sessions/*/events**', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        await route.continue();
      });
    }
    if (cpu > 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    }
    await page.reload();
    await expect(card.getByText('第 3 句').first()).toBeAttached({ timeout: 10_000 });
    // 断言不放宽：落定后的位置和刷新前逐像素一致
    await expect.poll(() => box(page), { timeout: 5_000 }).toEqual(settled);
    // 而且落定之后不再漂
    await page.waitForTimeout(600);
    expect(await box(page)).toEqual(settled);
  });
}
