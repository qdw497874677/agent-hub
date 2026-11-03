import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../scripts/bootstrap-worker.sh', import.meta.url));

function run(home: string, extra: Record<string, string>) {
  return spawnSync('bash', [script], {
    env: { PATH: process.env['PATH'] ?? '', HOME: home, HUB_PAIR: 'ahw_pair_test', AGENT_HUB_DIR: join(home, 'ah'), ...extra },
    encoding: 'utf8',
    timeout: 20_000
  });
}

test('预检：所有失败项一起列出后退出，什么都不动', () => {
  const home = mkdtempSync(join(tmpdir(), 'ahb-'));
  try {
    const r = run(home, { HUB_HTTP: 'http://127.0.0.1:9', PRE_MIN_FREE_KB: String(1e15), PRE_TOOLS: 'curl tar no-such-tool-x' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /预检没通过（一共 3 项/);
    assert.match(r.stderr, /可用空间/);
    assert.match(r.stderr, /缺少 no-such-tool-x/);
    assert.match(r.stderr, /连不上 http:\/\/127\.0\.0\.1:9\/api\/health/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('加锁：已有安装在跑时第二个实例提示后 exit 0', { skip: spawnSync('sh', ['-c', 'command -v flock']).status !== 0 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ahb-'));
  const lockDir = join(home, '.config', 'agent-hub');
  spawnSync('mkdir', ['-p', lockDir]);
  const holder = spawn('flock', [join(lockDir, 'install.lock'), 'sleep', '10']);
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const r = run(home, { HUB_HTTP: 'http://127.0.0.1:9' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /已有安装在进行/);
  } finally {
    holder.kill();
    rmSync(home, { recursive: true, force: true });
  }
});
