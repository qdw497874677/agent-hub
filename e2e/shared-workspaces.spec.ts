import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, expect, type Page } from '@playwright/test';
import { currentRun } from './run-id.ts';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';

/**
 * 团队工作目录的独占归属：一个目录同一时间只能属于一个项目。
 * 团队页建一个未分配目录 → 项目 A 分配 → 项目 B 看到「属于 A」并可转移 → 转移后 A 看不到、B 能直接开会话。
 * 桌面 1280 + 手机 390。
 */
const RUN = currentRun();
const SHOTS = process.env.SHOTS_DIR;

test.afterAll(() => stopFakeWorker());

async function csrfHeaders(page: Page, baseURL: string) {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  return { origin: baseURL, 'x-hub-csrf': csrf };
}

test('团队工作目录：新建 → A 分配 → B 转移 → 之后只有 B 能用', async ({ page, baseURL }) => {
  await loginByApi(page);
  const headers = await csrfHeaders(page, baseURL!);
  const workerId = await ensureFakeWorker(page, baseURL!);
  const dir = join(tmpdir(), `shared-ws-${RUN}`);
  mkdirSync(dir, { recursive: true });
  const mk = async (name: string) => {
    const made = await page.request.post('/api/projects', { data: { name, workerId }, headers });
    expect(made.status(), await made.text()).toBe(201);
    return (await made.json()) as { id: string; name: string };
  };
  const a = await mk(`shared-a-${RUN}`);
  const b = await mk(`shared-b-${RUN}`);
  const made = await page.request.post('/api/workspaces', { data: { mode: 'link', path: dir, workerId }, headers });
  expect(made.status(), await made.text()).toBeLessThan(300);
  const ws = (await made.json()) as { id: string; projectId: string | null; teamId: string | null };
  expect(ws.projectId).toBeNull();
  expect(ws.teamId).not.toBeNull();
  const viewsOf = async (projectId: string) =>
    (await (await page.request.get(`/api/projects/${projectId}/workspaces`)).json()) as Array<{ workspace: { id: string }; ownerProjectId?: string | null }>;

  try {
    // 首页「工作目录」入口 → 团队页，未分配
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await page.getByTestId('shell-more').click();
    await page.getByTestId('nav-workspaces').click();
    await expect(page.getByRole('heading', { name: '团队工作目录' })).toBeVisible();
    const row = page.getByTestId('team-ws-row').filter({ hasText: `shared-ws-${RUN}` });
    await expect(row).toContainText('未关联项目');
    await expect(page.getByTestId('team-ws-new')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/1280-team-unassigned.png`, fullPage: true });

    // 项目 A 里分配
    await page.goto(`/#/p/${a.id}`);
    await page.getByTitle('项目设置').first().click();
    const dialog = page.getByTestId('settings-surface');
    await dialog.getByRole('link', { name: '代码与工作目录', exact: true }).click();
    await dialog.getByTestId('ws-link-open').click();
    await dialog.getByTestId('ws-link').locator('li').filter({ hasText: `shared-ws-${RUN}` }).getByTestId('ws-link-one').click();
    await expect(dialog.getByText(dir.split('/').pop()!).first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: '取消关联' }).first()).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/1280-project-assigned.png`, fullPage: true });
    expect((await viewsOf(a.id)).map((v) => v.workspace.id)).toContain(ws.id);

    // 直接调接口再挂给 B：非要独占，被拒
    const conflict = await page.request.put(`/api/projects/${b.id}/workspaces/${ws.id}`, { headers });
    expect(conflict.status(), await conflict.text()).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'conflict' } });
    expect((await viewsOf(a.id)).map((v) => v.workspace.id)).toContain(ws.id);
    expect((await viewsOf(b.id)).map((v) => v.workspace.id)).not.toContain(ws.id);

    // 项目 B：入口里看到「属于 A」，走转移
    await page.goto(`/#/p/${b.id}`);
    await page.reload();
    await page.getByTitle('项目设置').first().click();
    const dialogB = page.getByTestId('settings-surface');
    await dialogB.getByRole('link', { name: '代码与工作目录', exact: true }).click();
    await dialogB.getByTestId('ws-link-open').click();
    const other = dialogB.getByTestId('ws-link').locator('li').filter({ hasText: `shared-ws-${RUN}` });
    await expect(other).toContainText(a.name);
    await other.getByTestId('ws-transfer').click();
    await expect(dialogB.getByTestId('ws-transfer-ask')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/1280-transfer-ask.png`, fullPage: true });
    await dialogB.getByTestId('ws-transfer-confirm').click();
    await expect(dialogB.getByTestId('ws-transfer-done')).toContainText(`shared-ws-${RUN}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/1280-transferred.png`, fullPage: true });
    expect((await viewsOf(b.id)).map((v) => v.workspace.id)).toContain(ws.id);
    expect((await viewsOf(a.id)).map((v) => v.workspace.id)).not.toContain(ws.id);
    await page.getByRole('button', { name: '返回应用' }).click();

    // 团队页：现在只属于 B
    await page.goto('/#/workspaces');
    await page.reload();
    const owned = page.getByTestId('team-ws-row').filter({ hasText: `shared-ws-${RUN}` });
    await expect(owned).toContainText(b.name);
    await expect(owned).not.toContainText(a.name);

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
      const title = `共享-${width}`;
      const task = await page.request.post('/api/tasks', { data: { projectId: b.id, title }, headers });
      expect(task.ok(), await task.text()).toBe(true);
      await page.goto(`/#/p/${b.id}/canvas`);
      await page.reload();
      await page.locator('.react-flow__node-task').filter({ hasText: title }).getByRole('button', { name: '＋ 会话' }).click();
      const run = page.getByRole('dialog', { name: '开始会话' });
      const agentSection = run.getByTestId('derive-agent-section');
      if (!(await run.locator('#derive-agent').isVisible())) await agentSection.locator('summary').click();
      await run.getByRole('combobox', { name: 'agent' }).selectOption(FAKE_AGENT_ID);
      const radio = run.getByRole('radio', { name: new RegExp(`shared-ws-${RUN}`) });
      await expect(radio).toBeVisible();
      await radio.click();
      await expect(radio).toHaveAttribute('aria-checked', 'true');
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}-picker-owned.png`, fullPage: true });
      await page.keyboard.press('Escape');
    }

    // 取消关联之后回到「未分配」，A 依然拿不到
    const unlinked = await page.request.delete(`/api/projects/${b.id}/workspaces/${ws.id}`, { headers });
    expect(unlinked.ok(), await unlinked.text()).toBe(true);
    expect((await viewsOf(b.id)).map((v) => v.workspace.id)).not.toContain(ws.id);
    expect((await viewsOf(a.id)).map((v) => v.workspace.id)).not.toContain(ws.id);
  } finally {
    await page.request.post(`/api/workspaces/${ws.id}/remove`, { data: { deleteDirectory: false, force: false }, headers });
    for (const p of [a, b]) await page.request.delete(`/api/projects/${p.id}`, { data: { confirmName: p.name }, headers });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('关联的团队工作目录里真的能开会话，也能「换个工作目录继续」进去', async ({ page, baseURL }) => {
  await loginByApi(page);
  const headers = await csrfHeaders(page, baseURL!);
  const workerId = await ensureFakeWorker(page, baseURL!);
  const dirs = [join(tmpdir(), `shared-run-a-${RUN}`), join(tmpdir(), `shared-run-b-${RUN}`)];
  for (const d of dirs) mkdirSync(d, { recursive: true });
  const project = (await (await page.request.post('/api/projects', { data: { name: `shared-run-${RUN}`, workerId }, headers })).json()) as { id: string; name: string };
  const made: Array<{ id: string; projectId: string | null }> = [];
  const sessionIds: string[] = [];
  try {
    for (const path of dirs) {
      const ws = await page.request.post('/api/workspaces', { data: { mode: 'link', path, workerId }, headers });
      expect(ws.status(), await ws.text()).toBeLessThan(300);
      const value = (await ws.json()) as { id: string; projectId: string | null };
      expect(value.projectId).toBeNull();
      made.push(value);
      const linked = await page.request.put(`/api/projects/${project.id}/workspaces/${value.id}`, { headers });
      expect(linked.ok(), await linked.text()).toBe(true);
    }
    const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '共享工作目录里干活' }, headers })).json()) as { id: string };
    const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: '', workerId, workspaceId: made[0]!.id }, headers });
    expect(derived.status(), await derived.text()).toBe(201);
    const session = (await derived.json()) as { id: string; workspaceId: string };
    sessionIds.push(session.id);
    expect(session.workspaceId).toBe(made[0]!.id);
    // 说一句，让会话有内容（e2e 里没有真 agent，有事件落库就行）
    await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text: '在共享工作目录里看看', attachments: [] }, headers });
    await expect
      .poll(async () => {
        const events = (await (await page.request.get(`/api/sessions/${session.id}/events`)).json()) as Array<{ kind?: string; event?: { kind?: string } }>;
        return events.length;
      }, { timeout: 15_000 })
      .toBeGreaterThan(0);

    const moved = await page.request.post(`/api/sessions/${session.id}/continue`, { data: { target: { kind: 'workspace', workspaceId: made[1]!.id } }, headers });
    expect(moved.status(), await moved.text()).toBe(201);
    const continued = (await moved.json()) as { id: string; workspaceId: string };
    sessionIds.push(continued.id);
    expect(continued.workspaceId).toBe(made[1]!.id);
  } finally {
    // 假 Agent 进程可能还在这两个目录里。先停会话，删项目被拒就不要拆目录。
    for (const id of sessionIds) await page.request.post(`/api/sessions/${id}/interrupt`, { headers }).catch(() => undefined);
    let removed = false;
    for (let i = 0; i < 25 && !removed; i++) {
      const del = await page.request.delete(`/api/projects/${project.id}`, { data: { confirmName: project.name }, headers }).catch(() => null);
      removed = del !== null && del.status() !== 409;
      if (!removed) await page.waitForTimeout(200);
    }
    for (const ws of made) await page.request.post(`/api/workspaces/${ws.id}/remove`, { data: { deleteDirectory: false, force: true }, headers });
    if (removed) for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});
