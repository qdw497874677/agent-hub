import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';

test.afterAll(() => stopFakeWorker());

for (const width of [1280, 390]) {
  test(`非模型设置反馈：专注页和画布，${width}px`, async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    await loginByApi(page);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
    const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
    const workerId = await ensureFakeWorker(page, baseURL!);
    const dir = mkdtempSync(join(tmpdir(), 'option-feedback-'));
    try {
      const project = await (await page.request.post('/api/projects', { data: { name: `选项反馈 ${width} ${Date.now()}`, rootPath: dir, workerId }, headers })).json() as { id: string };
      const task = await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '选项反馈' }, headers })).json() as { id: string };
      const response = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
      expect(response.ok(), await response.text()).toBeTruthy();
      const session = await response.json() as { id: string };
      let current = 'low';
      const spec = () => [{ id: 'effort', label: '思考强度', category: 'thought_level', kind: 'select', current, choices: ['low', 'high'].map((value) => ({ kind: 'value', value: { value, label: value } })) }];
      const inject = (s: any) => ({ ...s, options: { ...s.options, effort: current }, optionSpec: spec() });
      await page.route(`**/api/projects/${project.id}/canvas`, async (route) => {
        const result = await route.fetch();
        const body = await result.json();
        body.sessions = body.sessions.map((s: any) => s.id === session.id ? inject(s) : s);
        await route.fulfill({ response: result, json: body });
      });
      let reads = 0;
      await page.route(new RegExp(`/api/sessions/${session.id}$`), async (route) => {
        reads++;
        const result = await route.fetch();
        await route.fulfill({ response: result, json: inject(await result.json()) });
      });
      let mode: 'delayed' | 'immediate' | 'saved' | 'timeout' | 'rejected' = 'delayed';
      let release: (() => void) | undefined;
      let posts = 0;
      await page.route(`**/api/sessions/${session.id}/options`, async (route) => {
        posts++;
        expect(route.request().postDataJSON()).toEqual({ optionId: 'effort', value: mode === 'saved' ? 'low' : 'high', confirm: true });
        const body = await (await page.request.get(`/api/sessions/${session.id}`)).json();
        if (mode === 'delayed' || mode === 'timeout') await new Promise<void>((resolve) => { release = resolve; });
        if (mode === 'delayed' || mode === 'immediate') current = 'high';
        if (mode === 'saved') current = 'low';
        await route.fulfill({ json: { state: mode === 'saved' ? 'saved' : mode === 'rejected' ? 'rejected' : 'confirmed', session: inject(body) } }).catch(() => {});
      });
      await page.goto(`/#/p/${project.id}/focus/${session.id}`);
      const select = page.getByRole('combobox', { name: '思考强度' });
      const notice = page.getByTestId('option-feedback');
      await select.focus();
      await expect(select).toBeFocused();
      if (width === 390) {
        const box = await select.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
      }
      await select.selectOption('high');
      await expect(notice).toHaveAttribute('data-state', 'pending');
      await expect(notice).toContainText('正在切换到 high');
      await expect(select).toHaveValue('low');
      await expect(select).toBeDisabled();
      await page.getByLabel('发送消息').fill('可以发送');
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
      release?.();
      await expect(notice).toHaveAttribute('data-state', 'confirmed');
      await expect(select).toHaveValue('high');
      mode = 'saved';
      await select.selectOption('low');
      await expect(notice).toHaveAttribute('data-state', 'saved');
      await expect(notice).toContainText('供下次启动使用');
      mode = 'immediate';
      await select.selectOption('high');
      await expect(notice).toHaveAttribute('data-state', 'confirmed');
      await expect(select).toHaveValue('high');
      mode = 'saved';
      await select.selectOption('low');
      await expect(notice).toHaveAttribute('data-state', 'saved');
      mode = 'rejected';
      await select.selectOption('high');
      await expect(notice).toHaveAttribute('data-state', 'rejected');
      await expect(select).toHaveValue('low');
      mode = 'timeout';
      await select.selectOption('high');
      await expect(notice).toHaveAttribute('data-state', 'unconfirmed', { timeout: 16_000 });
      await expect(select).toBeEnabled();
      const beforeReads = reads;
      const beforePosts = posts;
      await page.getByRole('button', { name: '重新查看设置' }).click();
      await expect.poll(() => reads).toBeGreaterThan(beforeReads);
      await expect(notice).toContainText('最近读取到：low');
      await expect(notice).toContainText('不能确认之前发送的消息');
      expect(posts).toBe(beforePosts);
      // Switching surfaces preserves the same semantic status and does not submit again.
      await page.goto(`/#/p/${project.id}/canvas`);
      await expect(page.getByTestId('option-feedback').first()).toHaveAttribute('data-state', 'unconfirmed');
      expect(posts).toBe(beforePosts);
      const releaseOld = release;
      mode = 'delayed';
      await page.getByRole('combobox', { name: '思考强度' }).first().selectOption('high');
      await expect(page.getByTestId('option-feedback').first()).toHaveAttribute('data-state', 'pending');
      await expect.poll(() => posts).toBe(beforePosts + 1);
      await expect.poll(() => release !== releaseOld).toBe(true);
      release?.();
      await expect(page.getByTestId('option-feedback').first()).toHaveAttribute('data-state', 'confirmed');
      releaseOld?.();
      await expect(page.getByTestId('option-feedback').first()).toHaveAttribute('data-state', 'confirmed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
