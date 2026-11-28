import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { e2eWorkerPath } from './isolation.ts';
import { readHubLog, reservePort, spawnHub, stop } from './spawn-hub.ts';

const exec = promisify(execFile);
const fake = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');

test('external CLI through an enrolled remote worker and gated fake ACP', { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cli-'));
  const home = join(root, 'home'), repo = join(root, 'repo'), gates = join(root, 'g');
  await Promise.all([home, repo, gates].map((p) => mkdir(p, { recursive: true })));
  const path = e2eWorkerPath();
  const env = { PATH: path, HOME: home, TMPDIR: root, XDG_STATE_HOME: join(root, 'state'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const hubLog = join(root, 'hub.log'), workerLog = join(root, 'worker.log');
  t.diagnostic(`fixture and logs: ${root}`);
  await exec('git', ['init', '-q', repo], { env });
  const port = await reservePort(), base = `http://127.0.0.1:${port}`;
  const hub = spawnHub(process.execPath, ['apps/server/src/main.ts'], { env: { ...env, HUB_HOST: '127.0.0.1', HUB_PORT: String(port), HUB_DATA_DIR: join(root, 'data'), HUB_SPAWN_WORKER: '0', HUB_TEST_ACCOUNT: 'test@agent-hub.local', HUB_TEST_ACCOUNT_FILE: join(root, 'account'), HUB_MAIL_PROVIDER: 'log', HUB_MAIL_OUTBOX: join(root, 'outbox') }, logFile: hubLog, detached: true });
  let worker: ReturnType<typeof spawnHub> | undefined;
  async function until(label: string, fn: () => Promise<boolean>, ms = 30_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await sleep(150); }
    throw new Error(`timed out waiting for ${label}\nHub: ${readHubLog(hubLog)}\nWorker: ${readHubLog(workerLog)}`);
  }
  try {
    await until('Hub health and account', async () => existsSync(join(root, 'account')) && await fetch(`${base}/api/health`).then(r => r.ok).catch(() => false));
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'test@agent-hub.local', password: (await readFile(join(root, 'account'), 'utf8')).trim() }) });
    assert.equal(login.status, 200, 'fixture login');
    const cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
    const csrf = /hub_csrf=([^;]+)/.exec(cookie)?.[1]; assert.ok(csrf);
    async function browser(pathname: string, body?: unknown, method = 'POST'): Promise<any> {
      const response = await fetch(base + pathname, { method: body === undefined ? 'GET' : method, headers: { origin: base, cookie, 'x-hub-csrf': csrf!, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      assert.ok(response.ok, `${pathname}: HTTP ${response.status} ${text}`);
      return JSON.parse(text);
    }
    const pairing = await browser('/api/workers/pairing', {});
    const hubUrl = `ws://127.0.0.1:${port}/worker`;
    const enrolled = await exec(process.execPath, ['apps/worker/src/enroll.ts'], { env: { ...env, HUB_URL: hubUrl, HUB_PAIR: pairing.code, WORKER_LABEL: 'fixture' } });
    const [workerId, credential] = enrolled.stdout.trim().split('\n'); assert.ok(workerId && credential);
    worker = spawnHub(process.execPath, ['apps/worker/src/main.ts'], { env: { ...env, HUB_URL: hubUrl, HUB_WORKER_CREDENTIAL: credential, WORKER_ID: workerId, WORKER_ORIGIN: 'remote', WORKER_LABEL: 'fixture', WORKER_ROOTS: root, WORKER_STATE_DIR: join(root, 'worker'), WORKER_RUNTIMES_DIR: join(root, 'runtimes'), WORKER_GROUPS_DIR: join(root, 'groups'), WORKER_MODEL_CHECK: '0', ACP_AGENTS: JSON.stringify([{ id: 'fakeacp', label: 'Fake ACP', command: process.execPath, args: [fake, '--gate-dir', gates], listModelsArgs: [fake, '--models'] }]) }, logFile: workerLog, detached: true });
    const project = await browser('/api/projects', { name: 'CLI fixture' });
    const token = (await browser('/api/tokens', { name: 'CLI fixture', scopes: ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read'], projectIds: [project.id] })).token;
    assert.match(token, /^ahp_/);
    async function external(pathname: string): Promise<any> {
      const response = await fetch(`${base}/openapi/v1${pathname}`, { headers: { authorization: `Bearer ${token}` } });
      const text = await response.text(); assert.ok(response.ok, `${pathname}: HTTP ${response.status} ${text}`); return JSON.parse(text);
    }
    await until('remote fake ACP readiness', async () => (await external('/workers')).some((w: any) => w.workerId === workerId && w.state === 'online' && w.agentModels?.some((a: any) => a.agentId === 'fakeacp' && a.readiness?.state === 'ready' && a.models?.includes('fake/m1'))));
    const workspace = await browser(`/api/projects/${project.id}/workspaces`, { kind: 'long_lived', mode: 'link', path: repo, workerId });
    assert.equal(workspace.workerId, workerId);
    const cliEnv = { ...env, AHUB_HUB_URL: base, AHUB_API_TOKEN: token };
    async function cli(args: string[], input = '', hub = base): Promise<{ code: number | null; json: any }> {
      const child = spawn(process.execPath, ['scripts/ahub.ts', ...args, '--allow-http', '--json'], { env: { ...cliEnv, AHUB_HUB_URL: hub }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.setEncoding('utf8').on('data', s => { out += s; });
      child.stderr.setEncoding('utf8').on('data', s => { err += s; });
      child.stdin.end(input);
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      let json: any; try { json = JSON.parse(out); } catch { throw new Error(`CLI ${args.join(' ')}: exit ${code}, stdout ${out}, stderr ${err}`); }
      return { code, json };
    }
    const created = await cli(['task', 'create', '--project', project.id, '--title', 'fixture task']);
    assert.equal(created.code, 0, JSON.stringify(created));
    const taskId = created.json.taskId;
    const doctor = await cli(['doctor', '--task', taskId, '--worker', workerId, '--agent', 'fakeacp']);
    assert.equal(doctor.code, 0, JSON.stringify(doctor));
    assert.equal(doctor.json.workers.find((w: any) => w.workerId === workerId)?.workspaces.find((w: any) => w.workspaceId === workspace.id)?.availability, 'ready');
    const started = await cli(['session', 'start', '--task', taskId, '--worker', workerId, '--workspace', workspace.id, '--agent', 'fakeacp', '--model', 'fake/m1']);
    assert.equal(started.code, 0, JSON.stringify(started)); assert.equal(started.json.status, 'registered');
    const sid = started.json.sessionId;
    await until('session runtime ready', async () => (await browser(`/api/sessions/${sid}/startup`)).state === 'ready');
    const a = await cli(['session', 'send', sid, '--stdin'], 'please-hold:a');
    assert.equal(a.code, 0, JSON.stringify(a));
    await until('turn A reaches fake ACP', async () => existsSync(join(gates, 'hold-a.started')));
    const b = await cli(['session', 'send', sid, '--stdin'], 'please-hold:b');
    assert.equal(b.code, 0, JSON.stringify(b));
    assert.notEqual(a.json.deliveryId, b.json.deliveryId);
    await writeFile(join(gates, 'hold-a.go'), 'go');
    await until('turn B reaches fake ACP', async () => existsSync(join(gates, 'hold-b.started')));
    const journal = await browser(`/api/sessions/${sid}/events?after=0`);
    const endedA = journal.find((entry: any) => entry.event.kind === 'ended' && entry.event.deliveryId === a.json.deliveryId);
    assert.ok(endedA, 'A must have a persisted completion');
    assert.equal(endedA.turn, b.json.turn, 'the journal labels A completion with the already-enqueued B turn');
    const first = await cli(['session', 'wait', sid, '--turn', String(a.json.turn), '--timeout', '10']);
    assert.equal(first.code, 0, JSON.stringify(first)); assert.equal(first.json.deliveryId, a.json.deliveryId);
    const pending = await cli(['session', 'wait', sid, '--turn', String(b.json.turn), '--timeout', '1']);
    assert.equal(pending.code, 5, JSON.stringify(pending)); assert.equal(pending.json.deliveryId, b.json.deliveryId);
    await writeFile(join(gates, 'hold-b.go'), 'go');
    const second = await cli(['session', 'wait', sid, '--turn', String(b.json.turn), '--timeout', '10']);
    assert.equal(second.code, 0, JSON.stringify(second)); assert.equal(second.json.deliveryId, b.json.deliveryId);
    const final = await cli(['session', 'send', sid, '--stdin', '--wait', '--timeout', '15'], 'please-mark:success');
    assert.equal(final.code, 0, JSON.stringify(final)); assert.equal(final.json.status, 'done');
    assert.equal((await readFile(join(gates, 'mark-success.started'), 'utf8')).trim().split('\n').length, 1);

    // Forward the genuine request unchanged; discard its response only after the real Hub
    // has produced a complete successful ACK. All calls, including status, use this same
    // proxy origin so the checkpoint remains bound to the identical Hub URL.
    const promptPath = `/openapi/v1/sessions/${sid}/prompt`;
    const calls: { method: string; path: string }[] = [];
    let dropped = 0, upstreamStatus: number | undefined;
    const proxy = createServer((req, res) => {
      const method = req.method ?? 'GET', pathname = req.url ?? '/';
      calls.push({ method, path: pathname });
      const upstream = httpRequest(`${base}${pathname}`, { method, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (response) => {
        if (method === 'POST' && pathname === promptPath) {
          upstreamStatus = response.statusCode;
          response.resume();
          response.on('end', () => { dropped++; res.destroy(); });
        } else {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        }
      });
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
    });
    await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
    try {
      const address = proxy.address(); assert.ok(address && typeof address !== 'string');
      const proxyBase = `http://127.0.0.1:${address.port}`;
      const lost = await cli(['session', 'send', sid, '--stdin'], 'please-mark:lost', proxyBase);
      assert.equal(upstreamStatus, 202, 'Hub must have acknowledged persistence before response loss');
      assert.equal(dropped, 1);
      assert.equal(lost.code, 6, JSON.stringify(lost));
      assert.equal(lost.json.status, 'unknown');
      assert.ok(lost.json.operationId);
      await until('lost-ACK prompt reaches fake ACP', async () => existsSync(join(gates, 'mark-lost.started')));
      const beforeStatus = calls.length;
      // cli() starts a fresh Node process, reading the persisted checkpoint from disk.
      const recovered = await cli(['operation', 'status', lost.json.operationId], '', proxyBase);
      assert.equal(recovered.code, 6, JSON.stringify(recovered));
      assert.equal(recovered.json.status, 'unknown');
      assert.equal(recovered.json.operationId, lost.json.operationId);
      assert.ok(calls.slice(beforeStatus).every(call => call.method === 'GET'), JSON.stringify(calls.slice(beforeStatus)));
      assert.equal(calls.filter(call => call.method === 'POST' && call.path === promptPath).length, 1);
      const afterLoss = await browser(`/api/sessions/${sid}/events?after=0`);
      assert.equal(afterLoss.filter((entry: any) => entry.event.kind === 'prompt' && entry.event.text === 'please-mark:lost').length, 1);
      assert.equal((await readFile(join(gates, 'mark-lost.started'), 'utf8')).trim().split('\n').length, 1);
      t.diagnostic(`lost ACK: upstream HTTP ${upstreamStatus}, dropped ${dropped}, prompt POSTs 1, persisted prompts 1, fake ACP executions 1; restarted operation status unknown exit ${recovered.code}, network methods ${calls.slice(beforeStatus).map(call => call.method).join(',') || '(none)'}`);
    } finally {
      await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    }
  } finally {
    await Promise.all(['a', 'b'].map(key => writeFile(join(gates, `hold-${key}.go`), 'cleanup').catch(() => {})));
    if (worker) await stop(worker);
    await stop(hub);
  }
});
