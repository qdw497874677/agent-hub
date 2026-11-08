import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * OBSERVE=0 必须在独立进程里看：main.ts 启动时决定注不注册适配器。
 * 不继承当前 shell 的密钥类变量，数据目录和 HOME 都在临时目录。
 */
test('OBSERVE=0 的独立进程：登录后列表是未启用，健康检查仍在', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-observe-off-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const passwordFile = join(dir, 'test-account');
  const child: ChildProcess = spawn(process.execPath, ['apps/server/src/main.ts'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      HUB_HOST: '127.0.0.1',
      HUB_PORT: String(port),
      HUB_DATA_DIR: dir,
      HUB_SPAWN_WORKER: '0',
      OBSERVE: '0',
      HUB_TEST_ACCOUNT: 'test@agent-hub.local',
      HUB_TEST_ACCOUNT_FILE: passwordFile,
      HUB_MAIL_PROVIDER: 'log'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout?.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { logs += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let health = 0;
    for (let i = 0; i < 80; i++) {
      health = await fetch(`${base}/api/health`).then((res) => res.status).catch(() => 0);
      if (health === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(health, 200, logs.slice(-500));
    const password = (await readFile(passwordFile, 'utf8')).trim();
    assert.ok(password.length >= 10);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: 'test@agent-hub.local', password })
    });
    assert.equal(login.status, 200, await login.text());
    const cookie = login.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
    const observe = await fetch(`${base}/api/observe?since=0`, { headers: { cookie, origin: base } });
    assert.equal(observe.status, 200, await observe.clone().text());
    const body = await observe.json() as { enabled: boolean; items?: unknown[] };
    assert.equal(body.enabled, false);
    assert.deepEqual(body.items ?? [], []);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  } finally {
    child.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true });
  }
});
