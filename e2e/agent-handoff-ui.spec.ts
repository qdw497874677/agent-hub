import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';
import { showSessionHandoff } from './session-composer-controls.ts';

test.afterAll(() => stopFakeWorker());

for (const width of [1280, 390]) {
  test(`交接确认、首条与来源 ${width}px`, async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    await loginByApi(page);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
    const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
    const workerId = await ensureFakeWorker(page, baseURL!);
    const dir = mkdtempSync(join(tmpdir(), 'handoff-ui-'));
    try {
      const project = await (await page.request.post('/api/projects', { data: { name: `交接 ${width} ${Date.now()}`, rootPath: dir, workerId }, headers })).json() as { id: string };
      const task = await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '交接' }, headers })).json() as { id: string };
      const response = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
      expect(response.ok(), await response.text()).toBeTruthy();
      const source = await response.json() as { id: string };
      const target = `${source.id}-handoff`;
      let made = false, accepted = false, completed = false;
      let startup: 'pending' | 'claimed' | 'ready' | 'failed' | 'unknown' = 'pending';
      let holdMetadata = false, historyAvailable = false;
      let releaseMetadata: (() => void) | undefined;
      const creates: any[] = [], firsts: any[] = [], ordinary: string[] = [];
      await page.route('**/api/workers', async (route) => {
        const result = await route.fetch();
        const workers = await result.json();
        const worker = workers.find((w: any) => w.workerId === workerId);
        worker.agentModels = [...(worker.agentModels ?? []), { agentId: 'other-agent', models: ['other/model'], defaultModel: 'other/model', readiness: { state: 'ready' }, nativeHandoff: true }, { agentId: 'old-agent', models: ['old/model'], readiness: { state: 'ready' } }];
        await route.fulfill({ response: result, json: workers });
      });
      const patchSource = (session: any) => ({ ...session, optionSpec: [{ id: 'model', label: '模型', category: 'model', kind: 'select', current: 'native/a', choices: [{ kind: 'value', value: { value: 'native/a', label: 'native/a' } }] }] });
      await page.route(`**/api/projects/${project.id}/canvas`, async (route) => {
        const result = await route.fetch();
        const body = await result.json();
        const original = body.sessions.find((s: any) => s.id === source.id);
        body.sessions = body.sessions.map((s: any) => s.id === source.id ? patchSource(s) : s);
        if (made && original) body.sessions.push({ ...patchSource(original), id: target, agentId: 'other-agent', model: 'other/model' });
        await route.fulfill({ response: result, json: body });
      });
      await page.route('**/api/sessions/*/agent-handoff', async (route) => {
        const id = route.request().url().split('/').at(-2);
        if (route.request().method() === 'POST') {
          creates.push(route.request().postDataJSON());
          if (creates.length === 1) { await route.fulfill({ status: 429, json: { error: { code: 'busy', message: 'secret network detail' } } }); return; }
          if (creates.length === 2) { await route.fulfill({ status: 500 }); return; }
          if (creates.length === 3) { await route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'secret backend detail' } } }); return; }
          made = true;
          await route.fulfill({ json: { sessionId: target } });
          return;
        }
        if (id === target && holdMetadata) await new Promise<void>((resolve) => { releaseMetadata = resolve; });
        await route.fulfill({ json: { handoff: id === target ? { sourceSessionId: source.id, firstAccepted: accepted, ...(completed ? { firstCompleted: true } : {}), startup, historyAvailable } : null } }).catch(() => {});
      });
      await page.route(`**/api/sessions/${target}/agent-handoff/first`, async (route) => {
        firsts.push(route.request().postDataJSON());
        if (firsts.length === 1) { await route.fulfill({ status: 408 }); return; }
        if (firsts.length === 2) { await route.fulfill({ status: 500 }); return; }
        if (firsts.length === 3) { await route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'secret first detail' } } }); return; }
        accepted = true;
        await route.fulfill({ json: { ok: true, seq: 1, deliveryId: 'delivery', state: 'queued', turn: 1 } });
      });
      await page.route(`**/api/sessions/${target}/prompt`, async (route) => { ordinary.push(route.request().url()); await route.abort(); });
      await page.goto(`/#/p/${project.id}/focus/${source.id}`);
      const draft = page.getByLabel('发送消息');
      await draft.fill('原会话草稿');
      const openPicker = async () => (await showSessionHandoff(page, width < 640)).click();
      await openPicker();
      const pickerDialog = page.getByRole('dialog', { name: '选择要换的 Agent' });
      const unsupported = pickerDialog.getByRole('option', { name: /old-agent.*old\/model/ }).last();
      await expect(unsupported).toHaveAttribute('aria-disabled', 'true');
      await expect(unsupported).toContainText('暂不支持交接');
      await pickerDialog.getByRole('option', { name: /other-agent.*other\/model/ }).last().click();
      await expect(page.getByTestId('handoff-confirm')).toContainText('同一台机器、同一工作区');
      await page.getByTestId('handoff-confirm').getByRole('button', { name: '取消' }).click();
      expect(creates).toHaveLength(0);
      await expect(draft).toHaveValue('原会话草稿');
      await openPicker();
      await pickerDialog.getByRole('option', { name: /other-agent.*other\/model/ }).last().click();
      await page.getByRole('button', { name: '确认新建会话' }).click();
      await expect(page.getByTestId('handoff-confirm')).toContainText('未能确认是否创建成功');
      await expect(page.getByTestId('handoff-confirm')).not.toContainText('secret network detail');
      await page.reload();
      await openPicker();
      await pickerDialog.getByRole('option', { name: /other-agent.*other\/model/ }).last().click();
      await page.getByRole('button', { name: '确认新建会话' }).click();
      await expect(page.getByTestId('handoff-confirm')).toContainText('未能确认是否创建成功');
      expect(creates[0]).toEqual(creates[1]);
      await page.getByTestId('handoff-confirm').getByRole('button', { name: '取消' }).click();
      await draft.fill('原会话草稿');
      await openPicker();
      await pickerDialog.getByRole('option', { name: /other-agent.*other\/model/ }).last().click();
      holdMetadata = true;
      await page.getByRole('button', { name: '确认新建会话' }).click();
      await expect(page.getByTestId('handoff-confirm')).toContainText('本次创建请求被拒绝');
      await expect(page.getByTestId('handoff-confirm')).not.toContainText('secret backend detail');
      expect(creates[0]).toEqual(creates[2]);
      await page.getByRole('button', { name: '再次确认' }).click();
      await expect.poll(() => creates.length).toBe(4);
      expect(creates[0]).toEqual(creates[3]);
      await expect(page.getByText('正在核对会话来源，暂不能发送…')).toBeVisible();
      expect(ordinary).toHaveLength(0);
      releaseMetadata?.();
      const gate = page.getByTestId('handoff-gate');
      await expect(gate).toContainText('没有可用历史');
      await gate.getByLabel('交接后的首条消息').fill('目标首条');
      await expect(gate.getByRole('button', { name: '提交首条消息' })).toBeDisabled();
      await gate.getByLabel('我确认不带历史继续').check();
      await gate.getByRole('button', { name: '提交首条消息' }).click();
      await expect(gate).toContainText('不会自动重发');
      const storage = await page.evaluate(() => JSON.stringify(sessionStorage));
      expect(storage).not.toContain('目标首条');
      holdMetadata = false;
      await page.reload();
      await expect(gate).toContainText('刷新后请重新输入');
      await gate.getByLabel('交接后的首条消息').fill('不同内容');
      await gate.getByRole('button', { name: '再次确认首条消息' }).click();
      await expect(gate).toContainText('内容与原首条不一致');
      expect(firsts).toHaveLength(1);
      await gate.getByLabel('交接后的首条消息').fill('目标首条');
      await gate.getByRole('button', { name: '再次确认首条消息' }).click();
      await expect(gate).toContainText('不会自动重发');
      await gate.getByRole('button', { name: '再次确认首条消息' }).click();
      await expect(gate).toContainText('本次首条请求被拒绝');
      await expect(gate).not.toContainText('secret first detail');
      await expect(gate).toContainText('原请求不带历史');
      await expect(gate.getByLabel('交接后的首条消息')).toHaveValue('目标首条');
      await gate.getByRole('button', { name: '再次确认首条消息' }).click();
      await expect.poll(() => firsts.length).toBe(4);
      expect(firsts[0]).toEqual(firsts[1]);
      expect(firsts[0]).toEqual(firsts[2]);
      expect(firsts[0]).toEqual(firsts[3]);
      expect(firsts[0]).toMatchObject({ text: '目标首条', withHistory: false });
      await expect(gate).toContainText('首条已接收');
      await expect(gate).toContainText('首条已排队');
      await expect(gate).toContainText('暂不能发送');
      await expect(gate.getByRole('button', { name: '重新查看' })).toBeVisible();
      expect(ordinary).toHaveLength(0);
      startup = 'ready';
      await gate.getByRole('button', { name: '重新查看' }).click();
      await expect(gate).toContainText('不代表首轮已结束');
      await expect(gate.getByLabel('发送消息')).toBeVisible();
      completed = true;
      startup = 'unknown';
      await expect(gate).toContainText('首轮已结束', { timeout: 10_000 });
      await expect(gate.getByLabel('发送消息')).toBeVisible();
      await expect(gate).not.toContainText('启动结果未知');
      await gate.getByRole('link', { name: '返回来源会话' }).click();
      // Reload intentionally resets the app's in-memory drafts; navigation alone does not.
      await expect(draft).toHaveValue('');
      // The same gate guards canvas cards, including loading, available history and failed/unknown startup.
      accepted = false;
      completed = false;
      startup = 'pending';
      historyAvailable = true;
      holdMetadata = true;
      releaseMetadata = undefined;
      await page.goto(`/#/p/${project.id}/canvas`);
      await page.reload();
      await expect(page.getByText('正在核对会话来源，暂不能发送…').first()).toBeVisible();
      await expect.poll(() => releaseMetadata !== undefined).toBe(true);
      holdMetadata = false;
      releaseMetadata?.();
      const cardGate = page.getByTestId('handoff-gate');
      await expect(cardGate.getByLabel('携带可用历史')).toBeChecked();
      await expect(cardGate).toContainText('历史可能截短或省略');
      await cardGate.getByLabel('携带可用历史').uncheck();
      await expect(cardGate.getByLabel('我确认不带历史继续')).toBeVisible();
      startup = 'failed';
      await page.reload();
      await expect(cardGate).toContainText('运行时启动失败，不会自动重试');
      await expect(cardGate.getByRole('button', { name: /提交首条|再次确认/ })).toHaveCount(0);
      startup = 'unknown';
      await page.reload();
      await expect(cardGate).toContainText('启动结果未知，不会自动重试');
      await expect(cardGate.getByRole('link', { name: '返回来源会话' })).toBeVisible();
      expect(firsts).toHaveLength(4);
      expect(creates).toHaveLength(4);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
