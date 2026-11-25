import { spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { spawnHub, stop } from '../apps/server/src/test-support/spawn.ts';
import { e2eWorkerPath } from './isolation.ts';
import { loginByApi } from './login.ts';

const SECRET_ERROR = 'SYNTHETIC_PROVIDER_FAILURE_DO_NOT_EXPOSE';

// Use the actual binary but never its host config or credentials. The model
// endpoint is an isolated loopback fixture, not a provider account.
test('OpenCode 明确失败后不重放原消息，队列继续在桌面和手机可见', async ({ page, baseURL }) => {
  const binary = process.env.E2E_OPENCODE_BIN;
  test.skip(!binary, '设置 E2E_OPENCODE_BIN 运行真实 OpenCode + 本地模型回归');
  if (!binary || !baseURL) throw new Error('缺少 OpenCode 或 Hub 测试入口');
  const root = mkdtempSync(join(tmpdir(), 'ah-opencode-failed-'));
  const requests: ('first' | 'second')[] = [];
  const firstEffort: unknown[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((done) => { releaseFirst = done; });
  const provider = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }>; reasoning_effort?: unknown };
      const lastUser = input.messages?.findLast(({ role }) => role === 'user');
      const content = JSON.stringify(lastUser?.content ?? '');
      if (!String(input.messages?.[0]?.content ?? '').includes('You name conversations')) {
        if (content.includes('fixture-first-prompt')) {
          requests.push('first');
          firstEffort.push(input.reasoning_effort);
          await gate;
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: SECRET_ERROR, type: 'invalid_request_error', code: 'fixture_failure' } }));
          return;
        }
        if (content.includes('fixture-second-prompt')) requests.push('second');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'FIXTURE_REPLY' }, null], [{}, 'stop']]) {
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    } catch {
      res.writeHead(500).end();
    }
  });
  let worker: ChildProcess | undefined;
  try {
    await new Promise<void>((done, fail) => {
      provider.once('error', fail);
      provider.listen(0, '127.0.0.1', done);
    });
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('缺少模型测试端口');
    for (const dir of ['home', 'config/opencode', 'data', 'state', 'cache', 'cwd', 'tmp']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'config/opencode/opencode.json'), JSON.stringify({
      model: 'fixture/test',
      provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Fixture',
        options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'synthetic-not-a-secret' }, models: { test: { name: 'Test' } } } }
    }));
    const env = {
      PATH: e2eWorkerPath(), HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'), TMPDIR: join(root, 'tmp'),
      OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', NO_PROXY: '*'
    };
    await loginByApi(page);
    const csrf = (await page.context().cookies()).find(({ name }) => name === 'hub_csrf')?.value ?? '';
    const headers = { origin: baseURL, 'x-hub-csrf': csrf };
    const post = async <T>(url: string, data: unknown): Promise<T> => {
      const response = await page.request.post(url, { data, headers });
      expect(response.ok(), `${url}: ${await response.text()}`).toBe(true);
      return await response.json() as T;
    };
    const { code } = await post<{code: string}>('/api/workers/pairing', {});
    const workerUrl = `${baseURL.replace(/^http/, 'ws')}/worker`;
    const label = `opencode-fixture-${Date.now().toString(36)}`;
    const enrollment = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], {
      env: { ...env, HUB_URL: workerUrl, HUB_PAIR: code, WORKER_LABEL: label }, encoding: 'utf8', timeout: 15_000
    });
    expect(enrollment.status, 'fixture Worker enrollment').toBe(0);
    const [workerId, credential] = enrollment.stdout.trim().split('\n');
    if (!workerId || !credential) throw new Error('Worker 登记缺少标识或凭据');
    worker = spawnHub(process.execPath, ['apps/worker/src/main.ts'], { logFile: test.info().outputPath('worker.log'), env: {
      ...env, HUB_URL: workerUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_LABEL: label,
      WORKER_ORIGIN: 'remote', WORKER_ROOTS: join(root, 'cwd'), WORKER_STATE_DIR: join(root, 'state/worker'), WORKER_MODEL_CHECK: '0',
      WORKER_RUNTIMES_DIR: join(root, 'state/runtimes'), ACP_AGENTS: JSON.stringify([{
        id: 'opencode', label: 'OpenCode', command: resolve(binary), args: ['acp'], models: ['fixture/test'], defaultModel: 'fixture/test', codecId: 'opencode'
      }])
    }});
    await expect.poll(async () => {
      const response = await page.request.get('/api/workers');
      if (!response.ok()) return false;
      const workers = await response.json() as Array<{ workerId?: string; id?: string; state: string }>;
      return workers.some((item) => (item.workerId ?? item.id) === workerId && item.state === 'online');
    }).toBe(true);
    const project = await post<{ id: string }>('/api/projects', { name: label, rootPath: join(root, 'cwd'), workerId });
    const task = await post<{ id: string }>('/api/tasks', { projectId: project.id, title: 'OpenCode failure regression' });
    const session = await post<{ id: string }>('/api/sessions/derive', { taskId: task.id, agentId: 'opencode', model: '' });
    const api = `/api/sessions/${session.id}`;
    const get = async <T>(suffix: string): Promise<T> => {
      const response = await page.request.get(`${api}/${suffix}`);
      expect(response.ok()).toBe(true);
      return await response.json() as T;
    };
    type Delivery = { id: string; seq: number; state: string; attempt: number };
    type Entry = { seq: number; event: { kind: string; deliveryId?: string; outcome?: string; delta?: string } };
    const deliveries = async () => (await get<Delivery[]>('deliveries')).sort((a, b) => a.seq - b.seq);
    const states = async () => (await deliveries()).map(({ state, attempt }) => `${state}:${attempt}`);
    await page.goto(`/#/p/${project.id}/focus/${session.id}`);
    await expect(page.getByTestId('session-startup-status')).toHaveAttribute('data-state', 'ready');
    await page.getByRole('combobox', { name: 'Effort' }).selectOption('high');
    await expect(page.getByTestId('option-feedback')).toHaveAttribute('data-state', 'confirmed');
    await post(`${api}/prompt`, { text: 'fixture-first-prompt' });
    await expect.poll(() => requests).toEqual(['first']);
    expect(firstEffort).toEqual(['high']);
    await post(`${api}/prompt`, { text: 'fixture-second-prompt' });
    await expect.poll(states).toEqual(['sending:0', 'queued:0']);
    expect(requests).toEqual(['first']);
    releaseFirst();
    await expect.poll(states).toEqual(['delivered:1', 'delivered:1']);
    const [first, second] = await deliveries();
    const journal = await get<Entry[]>('events');
    expect(journal.filter(({ event }) => event.kind === 'ended').map(({ event }) => [event.deliveryId, event.outcome]))
      .toEqual([[first?.id, 'failed'], [second?.id, 'done']]);
    expect(JSON.stringify(journal)).not.toContain(SECRET_ERROR);
    expect(requests).toEqual(['first', 'second']);
    const firstEnd = journal.findIndex(({ event }) => event.kind === 'ended' && event.deliveryId === first?.id);
    expect(journal.findIndex(({ event }) => (event.delta ?? '').includes('FIXTURE_REPLY'))).toBeGreaterThan(firstEnd);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.reload();
      await expect(page.getByText('这一轮失败了', { exact: true })).toBeVisible();
      await expect(page.getByText('FIXTURE_REPLY', { exact: true })).toBeVisible();
      await expect(page.getByText(SECRET_ERROR)).toHaveCount(0);
    }
  } finally {
    releaseFirst();
    if (worker) await stop(worker);
    provider.closeAllConnections();
    if (provider.listening) await new Promise<void>((done) => provider.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
});
