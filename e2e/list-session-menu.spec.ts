import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';

/**
 * 列表视图里每条会话行自己的「⋯」：手机上常驻 44px，桌面上也看得见。
 * 它和行主体是两个按钮——点菜单不能顺手把人带进会话。删除沿用会话页同一个
 * 确认框和同一套禁用规则（跑着的先停）。
 */
test.use({ viewport: { width: 390, height: 844 } });
test.afterAll(() => stopFakeWorker());

interface StreamFrame {
  readonly sessionId: string;
  readonly event: unknown;
  readonly status: string;
}

test('列表行「⋯」：不导航就能删，取消保留，确认只删这一条且不删工作目录', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };

  const workerId = await ensureFakeWorker(page, baseURL!);

  // Worker 把进程拉起来后会补发一条「running」状态帧。这条帧要是晚于 interrupt 落盘，
  // 界面就会把已经 stopped 的会话又显示成运行中（库里仍是 stopped）。先旁听 SSE，
  // 等这条帧到了再停，测的才是真正的「停止之后」。
  const watcher = await page.context().newPage();
  await watcher.goto('/');
  await watcher.evaluate(() => {
    const w = window as unknown as { __frames?: StreamFrame[]; __stream?: EventSource };
    w.__frames = [];
    const source = new EventSource('/api/stream');
    w.__stream = source;
    source.addEventListener('frame', (message) => {
      w.__frames?.push(JSON.parse((message as MessageEvent<string>).data) as StreamFrame);
    });
  });
  await expect
    .poll(() => watcher.evaluate(() => (window as unknown as { __stream?: EventSource }).__stream?.readyState ?? 0))
    .toBe(1);
  const waitStarted = async (id: string): Promise<void> => {
    await expect
      .poll(
        () =>
          watcher.evaluate(
            (sessionId) =>
              ((window as unknown as { __frames?: StreamFrame[] }).__frames ?? []).some(
                (frame) => frame.sessionId === sessionId && frame.event === null && frame.status === 'running'
              ),
            id
          ),
        { timeout: 30_000, intervals: [100, 200, 500] }
      )
      .toBe(true);
  };

  const suffix = Date.now().toString(36);
  const dir = mkdtempSync(join(tmpdir(), 'e2e-list-menu-'));
  const project = (await (await page.request.post('/api/projects', {
    data: { name: `e2e 列表菜单 ${suffix}`, rootPath: dir, workerId },
    headers
  })).json()) as { id: string };
  const taskA = (await (await page.request.post('/api/tasks', {
    data: { projectId: project.id, title: `甲任务-${suffix}` },
    headers
  })).json()) as { id: string };
  const taskB = (await (await page.request.post('/api/tasks', {
    data: { projectId: project.id, title: `乙任务-${suffix}` },
    headers
  })).json()) as { id: string };

  const derive = async (taskId: string, title: string): Promise<string> => {
    const created = await page.request.post('/api/sessions/derive', {
      data: { taskId, agentId: FAKE_AGENT_ID, model: '', workerId },
      headers
    });
    expect(created.ok(), await created.text()).toBe(true);
    const { id } = (await created.json()) as { id: string };
    expect((await page.request.put(`/api/sessions/${id}/title`, { data: { title }, headers })).ok()).toBe(true);
    return id;
  };
  // 跑着的会话删不了：先停掉才能走确认删除；running 那条故意留着测禁用。
  const stop = async (id: string): Promise<void> => {
    expect((await page.request.post(`/api/sessions/${id}/interrupt`, { headers })).ok()).toBe(true);
  };

  const doomedTitle = `待删会话-${suffix}`;
  const runningTitle = `跑着的会话-${suffix}`;
  const keepTitle = `保留会话-${suffix}`;
  const doomed = await derive(taskA.id, doomedTitle);
  await waitStarted(doomed);
  await stop(doomed);
  const running = await derive(taskA.id, runningTitle);
  await waitStarted(running);
  const keep = await derive(taskB.id, keepTitle);
  await waitStarted(keep);
  await stop(keep);
  // 这条只是旁听用；关掉再进项目页，免得它和主页面抢同一个 SSE。
  await watcher.close();

  await page.goto(`/#/p/${project.id}/list`);
  await expect(page.getByTestId('list-view')).toBeVisible();

  const list = page.getByTestId('list-view');
  const row = (id: string) => list.locator(`li[data-session-id="${id}"]`);
  const more = (id: string) => row(id).getByTestId('list-session-more');
  await expect(more(doomed)).toBeVisible({ timeout: 30_000 });
  await expect(more(running)).toBeVisible();
  await expect(more(keep)).toBeVisible();
  await expect(page.getByRole('region', { name: `任务：甲任务-${suffix}` })).toContainText('2 条会话');
  await expect(page.getByRole('region', { name: `任务：乙任务-${suffix}` })).toContainText('1 条会话');

  // 手机上常驻且够大：44px 触控区，整行不横向溢出
  await expect(more(doomed)).toHaveAttribute('aria-label', `会话「${doomedTitle}」的操作`);
  await expect(more(doomed)).toHaveAttribute('aria-expanded', 'false');
  const mobileBox = await more(doomed).boundingBox();
  expect(mobileBox).not.toBeNull();
  expect(mobileBox!.width).toBeGreaterThanOrEqual(44);
  expect(mobileBox!.height).toBeGreaterThanOrEqual(44);
  expect(mobileBox!.x + mobileBox!.width).toBeLessThanOrEqual(390);
  expect((await row(doomed).boundingBox())!.x + (await row(doomed).boundingBox())!.width).toBeLessThanOrEqual(390);

  const listUrl = page.url();
  const menu = page.getByTestId('list-session-menu');

  // 1) 打开菜单不等于进会话：URL 不动，行主体没被点
  await more(doomed).click();
  await expect(menu).toBeVisible();
  await expect(more(doomed)).toHaveAttribute('aria-expanded', 'true');
  expect(page.url()).toBe(listUrl);
  await expect(menu.getByRole('menuitem')).toHaveText(['打开会话', '收起', '删除…']);
  // 常用菜单项本身也要够 44px，不能只把「⋯」做大。
  for (const item of await menu.getByRole('menuitem').all()) {
    expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const menuBox = await menu.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(390);
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(844);

  // 2) 取消：行还在，焦点回到这一行的「⋯」
  await menu.getByTestId('list-session-menu-delete').click();
  const dialog = page.getByTestId('session-delete-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(doomedTitle);
  const worktree = dialog.getByTestId('session-delete-worktree');
  await expect(worktree).not.toBeChecked();
  await dialog.getByTestId('session-delete-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(row(doomed)).toBeVisible();
  await expect(more(doomed)).toBeFocused();
  expect(page.url()).toBe(listUrl);

  // 3) 跑着的会话：停止就在行菜单里；收起和删除先禁用并写明原因。
  await more(running).click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['打开会话', '停止', '收起', '删除…']);
  const blocked = menu.getByTestId('list-session-menu-delete');
  await expect(blocked).toBeDisabled();
  await expect(blocked).toHaveAttribute('title', '先停止会话再删除');
  const blockedSettle = menu.getByTestId('list-session-menu-settle');
  await expect(blockedSettle).toBeDisabled();
  await expect(blockedSettle).toHaveAttribute('title', '会话还在跑，停下来才能收起');
  await menu.getByTestId('list-session-menu-interrupt').click();
  await expect(menu).toHaveCount(0);
  // 回执只说明中断请求送到了；运行时真正结束前不写「已停止」。
  await expect(page.getByTestId('list-action-toast')).toContainText(`已请求停止「${runningTitle}」`);
  await expect
    .poll(async () => {
      const current = (await (await page.request.get(`/api/projects/${project.id}/canvas`, { headers })).json()) as {
        sessions: { id: string; status: string }[];
      };
      return current.sessions.find((session) => session.id === running)?.status;
    })
    .not.toBe('running');

  // 4) 确认：请求体明确 removeWorktree:false；只删目标，任务和另两条会话都在
  await more(doomed).click();
  const deleting = page.waitForRequest(
    (request) => request.method() === 'DELETE' && new URL(request.url()).pathname === `/api/sessions/${doomed}`
  );
  await menu.getByTestId('list-session-menu-delete').click();
  await expect(dialog).toBeVisible();
  await expect(worktree).not.toBeChecked();
  await dialog.getByTestId('session-delete-confirm').click();
  const request = await deleting;
  expect(request.postDataJSON()).toEqual({ removeWorktree: false });
  await expect(dialog).toHaveCount(0);
  expect(page.url()).toBe(listUrl);

  await expect(row(doomed)).toHaveCount(0);
  await expect(row(running)).toBeVisible();
  await expect(row(keep)).toBeVisible();
  await expect(page.getByRole('region', { name: `任务：甲任务-${suffix}` })).toContainText('1 条会话');
  await expect(page.getByRole('region', { name: `任务：乙任务-${suffix}` })).toContainText('1 条会话');
  await expect(list.getByRole('button', { name: `任务详情：甲任务-${suffix}`, exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: `任务详情：乙任务-${suffix}`, exact: true })).toBeVisible();

  const canvas = (await (await page.request.get(`/api/projects/${project.id}/canvas`, { headers })).json()) as {
    sessions: { id: string }[];
    tasks: { id: string }[];
  };
  const sessionIds = canvas.sessions.map((session) => session.id);
  expect(sessionIds).not.toContain(doomed);
  expect(sessionIds).toContain(running);
  expect(sessionIds).toContain(keep);
  const taskIds = canvas.tasks.map((task) => task.id);
  expect(taskIds).toContain(taskA.id);
  expect(taskIds).toContain(taskB.id);

  // 4b) 收起可撤销：先收起，再点 toast 上的撤销，服务端 settledAt 回到空。
  await more(keep).click();
  await menu.getByTestId('list-session-menu-settle').click();
  const toast = page.getByTestId('list-action-toast');
  await expect(toast).toContainText(`已收起「${keepTitle}」`);
  await expect
    .poll(async () => {
      const current = (await (await page.request.get(`/api/projects/${project.id}/canvas`, { headers })).json()) as {
        sessions: { id: string; settledAt: number | null }[];
      };
      return current.sessions.find((session) => session.id === keep)?.settledAt ?? null;
    })
    .not.toBeNull();
  await page.getByTestId('list-action-undo').click();
  await expect
    .poll(async () => {
      const current = (await (await page.request.get(`/api/projects/${project.id}/canvas`, { headers })).json()) as {
        sessions: { id: string; settledAt: number | null }[];
      };
      return current.sessions.find((session) => session.id === keep)?.settledAt ?? null;
    })
    .toBeNull();
  await expect(page.getByTestId('list-action-toast')).toContainText(`已移回「${keepTitle}」`);

  await page.screenshot({ path: testInfo.outputPath('list-session-menu-390.png') });

  // 5) 桌面上也一直看得见（不靠 hover），点开仍然是同一个菜单。
  // 跨断点重排时行可能重新挂载；直接等待最终尺寸，不在两次读取之间假定 DOM 没换过。
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => {
    const box = await more(running).boundingBox({ timeout: 500 }).catch(() => null);
    return box ? Math.min(box.width, box.height) : 0;
  }).toBeGreaterThanOrEqual(24);
  await more(running).click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});
