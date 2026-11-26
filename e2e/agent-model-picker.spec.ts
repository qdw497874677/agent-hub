import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';

test.afterAll(() => stopFakeWorker());

for (const width of [1280, 390]) {
  test.describe(`${width}px viewport`, () => {
  if (width === 390) test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  test(`Agent 和模型：专注页与画布 ${width}px`, async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    await loginByApi(page);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
    const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
    const workerId = await ensureFakeWorker(page, baseURL!);
    const dir = mkdtempSync(join(tmpdir(), 'agent-model-'));
    try {
      const project = await (await page.request.post('/api/projects', { data: { name: `Agent 模型 ${width} ${Date.now()}`, rootPath: dir, workerId }, headers })).json() as { id: string };
      const task = await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '模型选择' }, headers })).json() as { id: string };
      const created = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
      expect(created.ok(), await created.text()).toBeTruthy();
      const session = await created.json() as { id: string };
      await page.route('**/api/sessions/*/agent-handoff', async (route) => route.fulfill({ json: { handoff: null } }));
      let current = 'local/a';
      let saved = 'local/a';
      let effort = 'low';
      let revision = Date.now();
      let includeModel = true;
      const spec = () => [
        ...(includeModel ? [{ id: 'model', label: '模型', category: 'model', kind: 'select', current, choices: ['local/a', 'local/b', 'hub-demo/c'].map((value) => ({ kind: 'value', value: { value, label: value } })) }] : []),
        { id: 'effort', label: '思考强度', category: 'thought_level', kind: 'select', current: effort, choices: (current === 'local/b' ? ['low', 'high', 'max'] : ['low', 'high']).map((value) => ({ kind: 'value', value: { value, label: value } })) },
        { id: 'agent', label: '模式 Agent', category: 'agent', kind: 'select', current: 'build', choices: ['build', 'plan'].map((value) => ({ kind: 'value', value: { value, label: value } })) }
      ];
      const inject = (s: any) => ({ ...s, updatedAt: new Date(revision).toISOString(), model: saved, options: { ...s.options, model: saved, effort, agent: 'build' }, optionSpec: spec() });
      await page.route(`**/api/projects/${project.id}/canvas`, async (route) => {
        const result = await route.fetch();
        const body = await result.json();
        body.sessions = body.sessions.map((s: any) => s.id === session.id ? inject(s) : s);
        await route.fulfill({ response: result, json: body });
      });
      let reads = 0;
      let holdRead = false;
      let releaseRead: (() => void) | undefined;
      await page.route(new RegExp(`/api/sessions/${session.id}$`), async (route) => {
        reads++;
        const result = await route.fetch();
        const body = inject(await result.json());
        if (holdRead) {
          holdRead = false;
          await new Promise<void>((resolve) => { releaseRead = resolve; });
        }
        await route.fulfill({ response: result, json: body }).catch(() => {});
      });
      let mode: 'delayed' | 'saved' | 'unconfirmed' | 'rejected' | 'mismatch' | 'stale' = 'delayed';
      let release: (() => void) | undefined;
      let posts = 0;
      await page.route(`**/api/sessions/${session.id}/options`, async (route) => {
        const request = route.request().postDataJSON();
        if (request.optionId === 'effort') {
          effort = request.value;
          revision += 1000;
          const body = await (await page.request.get(`/api/sessions/${session.id}`)).json();
          await route.fulfill({ json: { state: 'confirmed', session: inject(body) } });
          return;
        }
        posts++;
        expect(request).toEqual({ optionId: 'model', value: mode === 'delayed' ? 'local/b' : 'local/a', confirm: true });
        const body = await (await page.request.get(`/api/sessions/${session.id}`)).json();
        if (mode === 'stale') {
          current = 'local/a';
          saved = 'local/a';
          const staleReceipt = inject(body);
          current = 'local/b';
          saved = 'local/b';
          revision += 1000;
          await new Promise<void>((resolve) => { release = resolve; });
          await route.fulfill({ json: { state: 'confirmed', session: staleReceipt } }).catch(() => {});
          return;
        }
        if (mode === 'delayed') {
          await new Promise<void>((resolve) => { release = resolve; });
          current = 'local/b';
          saved = 'local/b';
        }
        if (mode === 'saved') saved = 'local/a';
        await route.fulfill({ json: { state: mode === 'delayed' || mode === 'mismatch' ? 'confirmed' : mode, session: inject(body) } }).catch(() => {});
      });
      await page.goto(`/#/p/${project.id}/focus/${session.id}`);
      const draft = page.getByLabel('发送消息');
      await draft.fill('保留草稿');
      const picker = page.getByTestId('session-model-trigger');
      await expect(picker).toContainText('a');
      await expect(page.getByRole('combobox', { name: '思考强度' })).toBeVisible();
      await expect(page.getByRole('combobox', { name: '模式 Agent' })).toBeVisible();
      await picker.click();
      const dialog = page.getByRole('dialog', { name: '选择模型' });
      await expect(dialog.getByTestId('session-model-current')).toContainText('当前会话：');
      await expect(dialog).toContainText('本机 · local');
      await expect(dialog).toContainText('Hub · hub-demo');
      await expect(dialog.getByRole('option', { name: /hub-demo\/c.*用此模型新开会话/ })).toBeVisible();
      await expect(dialog.getByRole('button', { name: '换 Agent', exact: true })).toHaveCount(0);
      await expect(page.getByTestId('agent-handoff-trigger')).toBeVisible();
      await dialog.getByRole('button', { name: '取消' }).click();
      await expect(picker).toBeFocused();
      expect(posts).toBe(0);
      await expect(draft).toHaveValue('保留草稿');
      await picker.click();
      const search = dialog.getByPlaceholder('搜索模型或提供方…');
      if (width < 640) await expect(search).not.toBeFocused();
      else await expect(search).toBeFocused();
      await search.fill('local/b');
      await dialog.getByRole('option', { name: /local\/b/ }).click();
      const notice = page.getByTestId('option-feedback').filter({ hasText: '模型：' });
      await expect(notice).toHaveAttribute('data-state', 'pending');
      await expect(picker).toContainText('a');
      await expect(draft).toHaveValue('保留草稿');
      holdRead = true;
      release?.();
      await expect(notice).toHaveAttribute('data-state', 'confirmed');
      await expect(picker).toContainText('b');
      await expect.poll(() => releaseRead !== undefined).toBe(true);
      await page.getByRole('combobox', { name: '思考强度' }).selectOption('high');
      await expect(page.getByRole('combobox', { name: '思考强度' })).toHaveValue('high');
      releaseRead?.();
      await expect(page.getByRole('combobox', { name: '思考强度' }).locator('option[value="max"]')).toHaveCount(1);
      await expect(page.getByRole('combobox', { name: '思考强度' })).toHaveValue('high');
      mode = 'saved';
      await picker.click();
      await dialog.getByRole('option', { name: /local\/a/ }).last().click();
      await expect(notice).toHaveAttribute('data-state', 'saved');
      await expect(notice).toContainText('供下次启动使用');
      await expect(picker).toContainText('b');
      await expect(page.getByTestId('model-observation')).toContainText('当前运行时报告：local/b；保存的启动模型：local/a');
      current = 'local/a';
      revision += 1000;
      await page.getByRole('combobox', { name: '思考强度' }).selectOption('high');
      await expect(page.getByRole('combobox', { name: '思考强度' })).toHaveValue('high');
      // A newer runtime observation can supersede a historic saved action.
      await page.goto(`/#/p/${project.id}/canvas`);
      await page.goto(`/#/p/${project.id}/focus/${session.id}`);
      await expect(picker).toContainText('a');
      await expect(draft).toHaveValue('保留草稿');
      current = 'local/b';
      revision += 1000;
      await page.goto(`/#/p/${project.id}/canvas`);
      await page.goto(`/#/p/${project.id}/focus/${session.id}`);
      await expect(picker).toContainText('b');
      mode = 'rejected';
      await picker.click();
      await dialog.getByRole('option', { name: /local\/a/ }).last().click();
      await expect(notice).toHaveAttribute('data-state', 'rejected');
      await expect(picker).toContainText('b');
      mode = 'stale';
      release = undefined;
      await picker.click();
      await dialog.getByRole('option', { name: /local\/a/ }).last().click();
      await expect.poll(() => release !== undefined).toBe(true);
      await page.goto(`/#/p/${project.id}/canvas`);
      await page.goto(`/#/p/${project.id}/focus/${session.id}`);
      await expect(picker).toContainText('b');
      release?.();
      await expect(notice).toHaveAttribute('data-state', 'confirmed');
      await expect(picker).toContainText('b');
      await expect(page.getByRole('combobox', { name: '思考强度' })).toHaveValue('high');
      mode = 'mismatch';
      await picker.click();
      await dialog.getByRole('option', { name: /local\/a/ }).last().click();
      await expect(notice).toHaveAttribute('data-state', 'unconfirmed');
      const beforeReads = reads;
      const beforePosts = posts;
      await page.getByRole('button', { name: '重新查看设置' }).click();
      await expect.poll(() => reads).toBeGreaterThan(beforeReads);
      expect(posts).toBe(beforePosts);
      await expect(notice).toContainText('最近读取到');
      await expect(draft).toHaveValue('保留草稿');
      await page.goto(`/#/p/${project.id}/canvas`);
      await expect(page.getByTestId('option-feedback').first()).toHaveAttribute('data-state', 'unconfirmed');
      const cardPicker = page.getByTestId('session-model-trigger').first();
      await expect(cardPicker).toContainText('b');
      await cardPicker.click();
      await expect(dialog.getByRole('option', { name: /local\/a/ }).last()).not.toHaveAttribute('aria-disabled', 'true');
      await dialog.getByRole('button', { name: '取消' }).click();
      includeModel = false;
      await page.reload();
      await expect(page.getByTestId('session-model-trigger').first()).toContainText('当前模型未确认');
      // An unknown current model cannot be switched in place, but other advertised Agents may still be offered.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('跨来源从原会话新建，不修改原设置或发送消息', async ({ page, baseURL }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await loginByApi(page);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
    const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
    const workerId = await ensureFakeWorker(page, baseURL!);
    const dir = mkdtempSync(join(tmpdir(), 'agent-model-new-'));
    try {
      const post = async <T>(url: string, data: object): Promise<T> => {
        const response = await page.request.post(url, { headers, data });
        expect(response.ok(), await response.text()).toBe(true);
        return response.json();
      };
      const project = await post<{ id: string }>('/api/projects', { name: `新模型 ${width} ${Date.now()}`, rootPath: dir, workerId });
      const task = await post<{ id: string }>('/api/tasks', { projectId: project.id, title: '保留原任务' });
      type Session = { id: string; taskId: string; workspaceId: string; workerId: string; agentId: string; model: string };
      const source = await post<Session>('/api/sessions/derive', { taskId: task.id, agentId: 'fakeacp', model: 'fake/m1', workerId });
      expect(source.workspaceId).toBeTruthy();
      // 模拟截图中的「Hub 模型正在使用」，确认请求落到真实的假 ACP Worker 本机模型目录，不调用提供商。
      const mockCurrent = (item: Session) => item.id !== source.id ? item : {
        ...item,
        optionSpec: [{ id: 'model', label: '模型', category: 'model', kind: 'select', current: 'hub-demo/e2e', choices: ['hub-demo/e2e', 'fake/m2'].map((value) => ({ kind: 'value', value: { value, label: value } })) }]
      };
      await page.route(`**/api/projects/${project.id}/canvas`, async (route) => {
        const response = await route.fetch();
        const data = await response.json() as { sessions: Session[] };
        await route.fulfill({ response, json: { ...data, sessions: data.sessions.map(mockCurrent) } });
      });
      await page.route(`**/api/sessions/${source.id}`, async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, json: mockCurrent(await response.json()) });
      });
      const writes: Array<{ url: string; body: unknown }> = [];
      page.on('request', (request) => {
        const url = new URL(request.url()).pathname;
        if (request.method() === 'POST' && /\/api\/sessions\/(derive|[^/]+\/(prompt|options))$/.test(url)) writes.push({ url, body: request.postDataJSON() });
      });
      await page.goto(`/#/p/${project.id}/focus/${source.id}`);
      await page.getByLabel('发送消息').fill('原会话草稿');
      const openConfirmation = async () => {
        await page.getByTestId('session-model-trigger').click();
        const dialog = page.getByRole('dialog', { name: '选择模型' });
        await expect(dialog.getByTestId('session-model-current')).toContainText('hub-demo/e2e');
        await expect(dialog.getByTestId('new-session-with-model')).toContainText('用此模型新开会话');
        await dialog.getByTestId('new-session-with-model').click();
        await expect(page.getByTestId('new-model-session-confirm')).toContainText('fake/m2');
      };
      await openConfirmation();
      const confirmation = page.getByTestId('new-model-session-confirm');
      await expect(confirmation).toContainText('原会话和草稿会保留');
      await confirmation.getByRole('button', { name: '取消', exact: true }).click();
      await expect(page.getByLabel('发送消息')).toHaveValue('原会话草稿');
      expect(writes).toEqual([]);
      await openConfirmation();
      await expect(confirmation.getByRole('button', { name: '新建会话', exact: true })).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath(`new-model-${width}.png`) });
      await confirmation.getByRole('button', { name: '新建会话', exact: true }).click();
      await expect.poll(() => new URL(page.url()).hash).toMatch(new RegExp(`^#/p/${project.id}/focus/(?!${source.id}$)[^/]+$`));
      const targetId = new URL(page.url()).hash.split('/').at(-1)!;
      expect(writes).toEqual([{ url: '/api/sessions/derive', body: { taskId: task.id, agentId: source.agentId, model: 'fake/m2', workerId, workspaceId: source.workspaceId } }]);
      const target = await (await page.request.get(`/api/sessions/${targetId}`)).json() as Session;
      expect(target).toMatchObject({ taskId: task.id, workerId, workspaceId: source.workspaceId, agentId: source.agentId, model: 'fake/m2' });
      const original = await (await page.request.get(`/api/sessions/${source.id}`)).json() as Session;
      expect(original.model).toBe('fake/m1');
      const events = await (await page.request.get(`/api/sessions/${targetId}/events`)).json() as Array<{ event: { kind: string } }>;
      expect(events.some(({ event }) => event.kind === 'prompt')).toBe(false);
      await page.goto(`/#/p/${project.id}/focus/${source.id}`);
      await expect(page.getByLabel('发送消息')).toHaveValue('原会话草稿');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  });
}
