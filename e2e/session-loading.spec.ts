import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { e2eWorkerPath } from './isolation.ts';

const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

for (const width of [1280, 390]) {
  test(`会话与记录分别加载，慢回执保留新草稿 (${width}px)`, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        private paused = false;
        private pause = () => { this.paused = true; this.dispatchEvent(new Event('error')); };
        private resume = () => { this.paused = false; this.dispatchEvent(new Event('open')); };
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          window.addEventListener('test-stream-pause', this.pause);
          window.addEventListener('test-stream-resume', this.resume);
          this.addEventListener('open', () => { document.documentElement.dataset.liveStreamOpened = 'true'; });
          this.addEventListener('frame', (message) => {
            if (this.paused) { message.stopImmediatePropagation(); return; }
            const frame = JSON.parse((message as MessageEvent<string>).data) as { event?: { kind: string; text?: string } };
            if (frame.event?.kind === 'prompt' && frame.event.text === '实时到达的新消息') {
              document.documentElement.dataset.livePromptReceived = 'true';
            }
          });
        }
        override close() {
          window.removeEventListener('test-stream-pause', this.pause);
          window.removeEventListener('test-stream-resume', this.resume);
          super.close();
        }
      };
    });
    await loginByApi(page);
    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
    const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
    const code = ((await (await page.request.post('/api/workers/pairing', { data: {}, headers })).json()) as { code: string }).code;
    const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
    const PATH = e2eWorkerPath();
    const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], { env: { PATH, HUB_URL: hubUrl, HUB_PAIR: code, WORKER_LABEL: `loading-${width}` }, encoding: 'utf8' });
    expect(enrolled.status, enrolled.stderr).toBe(0);
    const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
    // 临时项目走磁盘，worker 只允许访问这个用例自己的目录。
    const dir = mkdtempSync(join(process.cwd(), '.session-loading-'));
    const state = join(dir, 'worker');
    const agents = [{ id: 'fakeacp', label: '假 ACP', command: process.execPath, args: [FAKE], listModelsArgs: [FAKE, '--models'] }];
    const worker: ChildProcess = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      env: { PATH, HOME: dir, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote', WORKER_LABEL: `loading-${width}`, WORKER_ROOTS: dir, WORKER_STATE_DIR: state, WORKER_RUNTIMES_DIR: join(state, 'runtimes'), ACP_AGENTS: JSON.stringify(agents) },
      stdio: 'ignore'
    });
    const releases: Array<() => void> = [];
    try {
      await expect.poll(async () => {
        const workers = await (await page.request.get('/api/workers')).json() as Array<{ id?: string; workerId?: string; state: string }>;
        return workers.find((w) => (w.workerId ?? w.id) === workerId)?.state;
      }).toBe('online');
      const created = await page.request.post('/api/projects', { data: { name: `session-loading-${width}-${Date.now()}`, rootPath: dir, workerId }, headers });
      expect(created.ok(), await created.text()).toBe(true);
      const project = await created.json() as { id: string };
      const task = await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '加载测试' }, headers })).json() as { id: string };
      const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: 'fakeacp', model: '' }, headers });
      expect(derived.ok(), await derived.text()).toBe(true);
      const session = await derived.json() as { id: string };
      const url = `/#/p/${project.id}/focus/${session.id}`;
      const canvasPattern = `**/api/projects/${project.id}/canvas`;
      const sessionPattern = `**/api/sessions/${session.id}`;
      const eventsPattern = `**/api/sessions/${session.id}/events`;

      // 让真实会话不在投影里，从而经过与侧聊相同的单条会话查询。
      await page.route(canvasPattern, async (route) => {
        const response = await route.fetch();
        const data = await response.json() as { sessions: Array<{ id: string }> };
        data.sessions = data.sessions.filter((item) => item.id !== session.id);
        await route.fulfill({ response, json: data });
      });
      const canonicalGate = deferred(); releases.push(canonicalGate.release);
      let status = 403;
      await page.route(sessionPattern, async (route) => {
        await canonicalGate.promise;
        await route.fulfill({ status, json: { error: { code: 'test', message: 'test' } } });
      });
      await page.goto(url);
      const routeState = page.getByTestId('session-route-state');
      await expect(routeState).toContainText('正在读取会话');
      await expect(page.getByLabel('发送消息')).toHaveCount(0);
      await expect(page.locator('.react-flow')).toHaveCount(0);
      canonicalGate.release();
      await expect(routeState).toContainText('没有权限查看这条会话');
      status = 404;
      await routeState.getByRole('button', { name: '重试' }).click();
      await expect(routeState).toContainText('找不到这条会话');
      status = 500;
      await routeState.getByRole('button', { name: '重试' }).click();
      await expect(routeState).toContainText('会话读取失败');
      await expect(page.getByLabel('发送消息')).toHaveCount(0);

      await page.unroute(canvasPattern);
      await page.unroute(sessionPattern);
      let historyGate = deferred(); releases.push(historyGate.release);
      let failHistory = true;
      let snapshotCaptured: ReturnType<typeof deferred> | null = null;
      await page.route(eventsPattern, async (route) => {
        if (snapshotCaptured) {
          const response = await route.fetch();
          snapshotCaptured.release();
          await historyGate.promise;
          return route.fulfill({ response });
        }
        await historyGate.promise;
        if (failHistory) return route.fulfill({ status: 500, json: { error: { code: 'test', message: 'test' } } });
        return route.continue();
      });
      await page.reload();
      const history = page.getByTestId('session-history-state');
      await expect(history).toContainText('正在读取会话记录');
      await expect(page.getByText('这条会话还没有说话', { exact: false })).toHaveCount(0);
      const composer = page.getByLabel('发送消息');
      await expect(composer).toBeEditable();
      historyGate.release();
      await expect(history).toContainText('会话记录读取失败');
      failHistory = false;
      await history.getByRole('button', { name: '重试' }).click();
      await expect(history).toHaveCount(0);
      await expect(page.getByText('这条会话还没有说话', { exact: false })).toBeVisible();

      const oldText = '补齐前的历史消息';
      const seeded = await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text: oldText }, headers });
      expect(seeded.ok(), await seeded.text()).toBe(true);
      await expect.poll(async () => {
        const response = await page.request.get(`/api/sessions/${session.id}`);
        return ((await response.json()) as { status: string }).status;
      }).toBe('done');

      historyGate = deferred(); releases.push(historyGate.release);
      snapshotCaptured = deferred();
      await page.route(canvasPattern, async (route) => {
        const response = await route.fetch();
        const canvas = await response.json() as { previews: Record<string, unknown> };
        // 历史消息只能由完整读取补出，不能让画布的预览掩盖丢失。
        delete canvas.previews[session.id];
        await route.fulfill({ response, json: canvas });
      });
      await page.reload();
      await expect(history).toContainText('正在读取会话记录');
      await snapshotCaptured.promise;
      await expect(page.locator('html')).toHaveAttribute('data-live-stream-opened', 'true');
      const log = page.getByRole('log', { name: '会话记录' });
      await expect(log.getByText(oldText, { exact: true })).toHaveCount(0);
      const ackGate = deferred(); releases.push(ackGate.release);
      const ackReached = deferred();
      await page.route(`**/api/sessions/${session.id}/prompt`, async (route) => {
        const response = await route.fetch();
        ackReached.release();
        await ackGate.promise;
        await route.fulfill({ response });
      });
      await composer.fill('实时到达的新消息');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await ackReached.promise;
      await expect(page.locator('html')).toHaveAttribute('data-live-prompt-received', 'true');
      await composer.fill('回执期间写的草稿');
      ackGate.release();
      await expect(history).toContainText('正在读取会话记录');
      await expect(composer).toHaveValue('回执期间写的草稿');
      historyGate.release();
      await expect(history).toHaveCount(0);
      await expect(log.getByText(oldText, { exact: true })).toHaveCount(1);
      await expect(log.getByText('实时到达的新消息', { exact: true })).toHaveCount(1);
      await expect(page.getByRole('button', { name: /^(发送|排队发送)$/ })).toBeEnabled();
      await expect(composer).toHaveValue('回执期间写的草稿');

      // 断线时遗漏的记录以真实 journal 为准；失败不能伪装成没有新消息。
      snapshotCaptured = null;
      const syncGate = deferred(); releases.push(syncGate.release);
      let failSync = true;
      await page.route((url) => url.pathname === `/api/sessions/${session.id}/events` && url.searchParams.has('after'), async (route) => {
        await syncGate.promise;
        if (failSync) return route.fulfill({ status: 500, json: { error: { code: 'test', message: 'test' } } });
        return route.continue();
      });
      await expect.poll(async () => {
        const response = await page.request.get(`/api/sessions/${session.id}`);
        return ((await response.json()) as { status: string }).status;
      }).toBe('done');
      await page.evaluate(() => window.dispatchEvent(new Event('test-stream-pause')));
      const missedText = '断线期间的消息';
      const missed = await page.request.post(`/api/sessions/${session.id}/prompt`, { data: { text: missedText }, headers });
      expect(missed.ok(), await missed.text()).toBe(true);
      await page.evaluate(() => window.dispatchEvent(new Event('test-stream-resume')));
      const sync = page.getByTestId('session-sync-state');
      await expect(sync).toHaveAttribute('data-state', 'syncing');
      await expect(log.getByText(oldText, { exact: true })).toBeVisible();
      await expect(log.getByText(missedText, { exact: true })).toHaveCount(0);
      syncGate.release();
      await expect(sync).toHaveAttribute('data-state', 'stale');
      await expect(composer).toHaveValue('回执期间写的草稿');
      failSync = false;
      await sync.getByRole('button', { name: '重试' }).click();
      await expect(log.getByText(missedText, { exact: true })).toHaveCount(1);
      await expect(log.getByText('实时到达的新消息', { exact: true })).toHaveCount(1);
      await expect(sync).toHaveCount(0);

      // 没有新消息的重连不应挪动已有正文，也不应改变输入框位置。
      await expect.poll(async () => {
        const response = await page.request.get(`/api/sessions/${session.id}`);
        return ((await response.json()) as { status: string }).status;
      }).toBe('done');
      await expect(log.getByTestId('msg-assistant')).toHaveCount(3);
      await expect(log.getByTestId('msg-assistant').last()).toContainText('session/prompt,session/prompt,session/prompt');
      const position = () => page.evaluate((text) => {
        const history = document.querySelector('[role="log"][aria-label="会话记录"]');
        const message = [...(history?.querySelectorAll('[data-testid="msg-user"]') ?? [])].find((node) => node.textContent?.includes(text));
        const composer = document.querySelector('textarea[aria-label="发送消息"]');
        return [message?.getBoundingClientRect().top ?? -1, composer?.getBoundingClientRect().top ?? -1];
      }, oldText);
      const beforeSync = await position();
      expect(beforeSync[0]).toBeGreaterThanOrEqual(0);
      expect(beforeSync[1]).toBeGreaterThan(0);
      const quietGate = deferred(); releases.push(quietGate.release);
      await page.route((url) => url.pathname === `/api/sessions/${session.id}/events` && url.searchParams.has('after'), async (route) => {
        await quietGate.promise;
        await route.continue();
      });
      await page.evaluate(() => window.dispatchEvent(new Event('test-stream-pause')));
      await expect(sync).toHaveAttribute('data-state', 'stale');
      expect(await position()).toEqual(beforeSync);
      await page.evaluate(() => window.dispatchEvent(new Event('test-stream-resume')));
      await expect(sync).toHaveAttribute('data-state', 'syncing');
      expect(await position()).toEqual(beforeSync);
      quietGate.release();
      await expect(sync).toHaveCount(0);
      expect(await position()).toEqual(beforeSync);
    } finally {
      for (const release of releases) release();
      worker.kill();
      await page.request.delete(`/api/workers/${encodeURIComponent(workerId)}`, { headers }).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
