import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHermesRuntime, hermesShouldRestart } from './hermes-runtime.ts';
import type { SessionId, StartSpec, TaskId } from '@agent-hub/domain';

test('只有退出 75 且刚装过依赖才再启动一次', () => {
  const stderr = '→ Installing Python dependencies…\n✓ Installing Python dependencies\n';
  assert.equal(hermesShouldRestart(75, stderr, 0), true);
  assert.equal(hermesShouldRestart(75, stderr, 1), false);
  assert.equal(hermesShouldRestart(75, 'something else', 0), false);
  assert.equal(hermesShouldRestart(1, stderr, 0), false);
});

test('假网关先以 75 退出，再启动一次后能起来；第二次仍是 75 就失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hermes-restart-'));
  const marker = join(root, 'booted');
  const script = join(root, 'fake-hermes.mjs');
  await writeFile(script, `#!/usr/bin/env node
import { createServer } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
const marker = process.env.MARKER;
const always = process.env.ALWAYS_75 === '1';
if (always || !existsSync(marker)) {
  writeFileSync(marker, '1');
  process.stderr.write('→ Installing Python dependencies…\\n✓ Installing Python dependencies\\n');
  process.exit(75);
}
const server = createServer((req, res) => {
  if (req.url === '/health') return res.writeHead(200).end('ok');
  if (req.url === '/v1/capabilities') {
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ features: { run_submission: true, run_status: true, run_events_sse: true, run_stop: true } }));
  }
  if (req.method === 'POST' && req.url === '/api/sessions') return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  res.writeHead(404).end();
});
server.listen(Number(process.env.API_SERVER_PORT), '127.0.0.1');
`);
  await chmod(script, 0o755);
  const logs: string[] = [];
  const runtime = createHermesRuntime({ root: join(root, 'home'), command: script, log: (message) => logs.push(message), bootTimeoutMs: 10_000, env: { PATH: process.env.PATH ?? '', MARKER: marker } });
  const started = await runtime.start({
    sessionId: 's1' as SessionId,
    taskId: 't' as TaskId,
    workspaceRoot: root,
    resume: null,
    options: {},
    provider: { baseUrl: 'http://127.0.0.1:9/v1', token: 'local-fake', models: [{ id: 'fake-1', name: 'fake-1' }] }
  } as unknown as StartSpec);
  assert.equal(started.ok, true, started.ok ? '' : started.error.message);
  assert.ok(logs.some((line) => line.includes('再启动一次')));
  if (started.ok) await started.value.dispose();

  const stuck = join(root, 'stuck');
  const again = createHermesRuntime({ root: join(root, 'home2'), command: script, log: () => undefined, bootTimeoutMs: 5_000, env: { PATH: process.env.PATH ?? '', MARKER: stuck, ALWAYS_75: '1' } });
  const failed = await again.start({
    sessionId: 's2' as SessionId,
    taskId: 't' as TaskId,
    workspaceRoot: root,
    resume: null,
    options: {},
    provider: { baseUrl: 'http://127.0.0.1:9/v1', token: 'local-fake', models: [{ id: 'fake-1', name: 'fake-1' }] }
  } as unknown as StartSpec);
  assert.equal(failed.ok, false);
});
