import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hubProviderBody } from './hub-model.ts';
import { playwrightWebServerEnv, serverEnv } from './server-env.ts';

const KEY = 'sk-test-placeholder-not-real';
const GO = 'sk-go-placeholder-not-real';
const RELAY = 'relay-placeholder';
const FORBIDDEN = ['ZAI_CODING_CN_API_KEY', 'ZAI_API_KEY', 'OPENCODE_API_KEY', 'OPENCODE_GO_API_KEY', 'PI_DEFAULT_MODEL'] as const;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function envNames(pid: number): Set<string> {
  const raw = readFileSync(`/proc/${pid}/environ`);
  const names = new Set<string>();
  for (const entry of raw.toString('utf8').split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) names.add(entry.slice(0, eq));
  }
  return names;
}

function descendants(pid: number): number[] {
  let text = '';
  try {
    text = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8');
  } catch {
    return [];
  }
  const kids = text.trim().split(/\s+/).filter(Boolean).map(Number);
  return kids.flatMap((child) => [child, ...descendants(child)]);
}

function cmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replaceAll('\0', ' ');
  } catch {
    return '';
  }
}

function assertAbsent(pid: number, label: string): void {
  const names = envNames(pid);
  for (const name of FORBIDDEN) assert.equal(names.has(name), false, `${label} ${name}`);
  assert.equal(names.has('HUB_PROVIDER_TOKEN'), true, label);
}

async function launch(env: NodeJS.ProcessEnv, command: string): Promise<ChildProcess> {
  const child = spawn(command, [], { env, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  return child;
}

function stop(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

test('Playwright 仍先展开 process.env；delete 会让 shell 继承密钥名，undefined 不会', async () => {
  const source = readFileSync(new URL('../node_modules/playwright/lib/runner/index.js', import.meta.url), 'utf8');
  assert.match(source, /env:\s*\{\s*\.\.\.DEFAULT_ENVIRONMENT_VARIABLES,\s*\.\.\.process\.env,\s*\.\.\.this\._options\.env\s*\}/);
  assert.match(source, /shell:\s*true/);

  const parent: NodeJS.ProcessEnv = {
    ...process.env,
    ZAI_CODING_CN_API_KEY: KEY,
    ZAI_API_KEY: KEY,
    OPENCODE_API_KEY: GO,
    OPENCODE_GO_API_KEY: GO,
    PI_DEFAULT_MODEL: 'opencode-go/deepseek-v4-flash',
    E2E_HUB_MODEL: 'hub-cn-glm-flash/glm-5.3-flash',
    HUB_PROVIDER_TOKEN: RELAY
  };
  const deleted = { ...parent };
  for (const name of FORBIDDEN) delete deleted[name];
  const leaked = playwrightWebServerEnv(parent, deleted);
  const covered = playwrightWebServerEnv(parent, serverEnv(parent));
  assert.equal(leaked['ZAI_CODING_CN_API_KEY'], KEY);
  assert.equal(covered['ZAI_CODING_CN_API_KEY'], undefined);
  assert.equal(covered['OPENCODE_GO_API_KEY'], undefined);
  assert.equal(covered['HUB_PROVIDER_TOKEN'], RELAY);

  const leakedChild = await launch(leaked, 'sleep 30');
  const coveredChild = await launch(covered, 'sleep 30');
  try {
    assert.ok(leakedChild.pid);
    assert.ok(coveredChild.pid);
    assert.equal(envNames(leakedChild.pid).has('ZAI_CODING_CN_API_KEY'), true);
    assert.equal(envNames(coveredChild.pid).has('ZAI_CODING_CN_API_KEY'), false);
    assert.equal(envNames(coveredChild.pid).has('OPENCODE_GO_API_KEY'), false);
    assert.equal(envNames(coveredChild.pid).has('HUB_PROVIDER_TOKEN'), true);
  } finally {
    stop(leakedChild);
    stop(coveredChild);
  }
});

test('真实 shell 拉起 hub 与 worker 后环境里没有占位密钥，测试进程仍能创建供应商', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-e2e-env-'));
  const port = await freePort();
  const passwordFile = join(dir, 'test-account');
  const parent: NodeJS.ProcessEnv = {
    ...process.env,
    ZAI_CODING_CN_API_KEY: KEY,
    ZAI_API_KEY: KEY,
    OPENCODE_API_KEY: GO,
    OPENCODE_GO_API_KEY: GO,
    PI_DEFAULT_MODEL: 'opencode-go/deepseek-v4-flash',
    E2E_HUB_MODEL: 'hub-cn-glm-flash/glm-5.3-flash'
  };
  const configEnv = {
    ...serverEnv(parent),
    HOME: dir,
    HUB_HOST: '127.0.0.1',
    HUB_PORT: String(port),
    HUB_DATA_DIR: dir,
    HUB_SPAWN_WORKER: '1',
    HUB_TEST_ACCOUNT: 'test@agent-hub.local',
    HUB_TEST_ACCOUNT_FILE: passwordFile,
    HUB_MAIL_PROVIDER: 'log',
    WORKER_ROOTS: '/tmp',
    WORKER_STATE_DIR: join(dir, 'worker'),
    WORKER_MODEL_CHECK: '0',
    WORKER_ID: 'e2e-env-boundary',
    HUB_PROVIDER_TOKEN: RELAY
  };
  const launched = playwrightWebServerEnv(parent, configEnv);
  assert.equal(parent['ZAI_CODING_CN_API_KEY'], KEY);
  const child = await launch(launched, 'node apps/server/src/main.ts');
  let logs = '';
  child.stdout?.on('data', (chunk: Buffer) => { logs += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { logs += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let health = 0;
    for (let i = 0; i < 80 && health !== 200; i++) {
      health = await fetch(`${base}/api/health`).then((res) => res.status).catch(() => 0);
      if (health !== 200) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(health, 200);
    assert.ok(child.pid);
    const pids = [child.pid, ...descendants(child.pid)];
    const serverPid = pids.find((pid) => cmdline(pid).includes('apps/server/src/main.ts'));
    let workerPid = 0;
    for (let i = 0; i < 30 && !workerPid; i++) {
      workerPid = [child.pid, ...descendants(child.pid)].find((pid) => cmdline(pid).includes('apps/worker/src/main.ts')) ?? 0;
      if (!workerPid) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(serverPid, 'hub 进程');
    assert.ok(workerPid, 'worker 进程');
    assertAbsent(child.pid, 'shell');
    assertAbsent(serverPid, 'hub');
    assertAbsent(workerPid, 'worker');

    const password = (await readFile(passwordFile, 'utf8')).trim();
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: 'test@agent-hub.local', password })
    });
    assert.equal(login.status, 200);
    const cookies = login.headers.getSetCookie().map((line) => line.split(';')[0] ?? '');
    const csrf = cookies.find((line) => line.startsWith('hub_csrf='))?.slice('hub_csrf='.length) ?? '';
    assert.ok(csrf);
    const created = await fetch(`${base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: cookies.join('; '), 'x-hub-csrf': csrf },
      body: JSON.stringify(hubProviderBody({ slug: 'cn-glm-flash', modelId: 'glm-5.3-flash' }, 'https://open.bigmodel.cn/api/coding/paas/v4', KEY))
    });
    const text = await created.text();
    assert.equal(created.status, 201);
    assert.equal(text.includes(KEY), false);
    assert.equal(text.includes(GO), false);
    assert.equal(text.includes('"apiKey"'), false);
    assert.equal((JSON.parse(text) as { hasKey: boolean }).hasKey, true);
    assert.equal(logs.includes(KEY), false);
    assert.equal(logs.includes(GO), false);
  } finally {
    stop(child);
    await rm(dir, { recursive: true, force: true });
  }
});
