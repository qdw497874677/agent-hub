import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';

test.afterAll(() => stopFakeWorker());

for (const width of [1280, 390]) {
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
      const picker = page.getByRole('button', { name: /Agent 和模型：/ });
      await expect(picker).toContainText('a');
      await expect(page.getByRole('combobox', { name: '思考强度' })).toBeVisible();
      await expect(page.getByRole('combobox', { name: '模式 Agent' })).toBeVisible();
      await picker.click();
      const dialog = page.getByRole('dialog', { name: '选择Agent 和模型' });
      await expect(dialog).toContainText('当前：');
      await expect(dialog).toContainText('本机 · local');
      await expect(dialog).toContainText('Hub · hub-demo');
      await expect(dialog).toContainText('需要重启，暂不支持在此切换');
      await expect(dialog.getByRole('option', { name: /hub-demo\/c/ })).toHaveAttribute('aria-disabled', 'true');
      await dialog.getByRole('button', { name: '取消' }).click();
      await expect(picker).toBeFocused();
      expect(posts).toBe(0);
      await expect(draft).toHaveValue('保留草稿');
      await picker.click();
      const search = dialog.getByPlaceholder('搜索 Agent、模型或提供方…');
      const agentName = (await picker.getAttribute('aria-label'))!.split('：')[1]!.split(' · ')[0]!;
      await search.fill(agentName);
      await expect(dialog.getByRole('option')).toHaveCount(3);
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
      await page.getByRole('dialog', { name: '选择Agent 和模型' }).getByRole('option', { name: /local\/a/ }).last().click();
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
      await page.getByRole('dialog', { name: '选择Agent 和模型' }).getByRole('option', { name: /local\/a/ }).last().click();
      await expect(notice).toHaveAttribute('data-state', 'rejected');
      await expect(picker).toContainText('b');
      mode = 'stale';
      release = undefined;
      await picker.click();
      await page.getByRole('dialog', { name: '选择Agent 和模型' }).getByRole('option', { name: /local\/a/ }).last().click();
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
      await page.getByRole('dialog', { name: '选择Agent 和模型' }).getByRole('option', { name: /local\/a/ }).last().click();
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
      const cardPicker = page.getByRole('button', { name: /Agent 和模型：/ }).first();
      await expect(cardPicker).toContainText('b');
      await cardPicker.click();
      await expect(page.getByRole('dialog', { name: '选择Agent 和模型' }).getByRole('option', { name: /local\/a/ }).last()).not.toHaveAttribute('aria-disabled', 'true');
      await page.getByRole('dialog', { name: '选择Agent 和模型' }).getByRole('button', { name: '取消' }).click();
      includeModel = false;
      await page.reload();
      await expect(page.getByRole('button', { name: /Agent 和模型：/ }).first()).toContainText('当前模型未确认');
      // An unknown current model cannot be switched in place, but other advertised Agents may still be offered.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
