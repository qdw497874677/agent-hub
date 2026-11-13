import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetupScript, scrubCredentials, setupEnv, tailOutput, SETUP_OUTPUT_MAX } from './setup-script.ts';

const dir = async (): Promise<string> => mkdtemp(join(tmpdir(), 'agent-hub-setup-'));

test('准备命令：成功时回退出码 0 和输出', async () => {
  const cwd = await dir();
  try {
    const out = await runSetupScript({ path: cwd, command: 'echo hello && pwd', timeoutMs: 5000 });
    assert.equal(out.exitCode, 0);
    assert.equal(out.timedOut, false);
    assert.match(out.output, /hello/);
    assert.match(out.output, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('准备命令：非零退出码原样报回', async () => {
  const cwd = await dir();
  try {
    const out = await runSetupScript({ path: cwd, command: 'echo boom >&2; exit 3', timeoutMs: 5000 });
    assert.equal(out.exitCode, 3);
    assert.equal(out.timedOut, false);
    assert.match(out.output, /boom/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('准备命令：超时整组杀掉，返回 124', async () => {
  const cwd = await dir();
  try {
    const out = await runSetupScript({ path: cwd, command: 'sleep 30', timeoutMs: 150 });
    assert.equal(out.timedOut, true);
    assert.equal(out.exitCode, 124);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('准备命令：只留最后 8KB，并抹掉 user:token@', async () => {
  const cwd = await dir();
  try {
    const out = await runSetupScript({
      path: cwd,
      command: `head -c 20000 /dev/zero | tr '\\0' 'x'; printf '\\nhttps://alice:s3cr3t@example.com/repo\\n'`,
      timeoutMs: 5000
    });
    assert.equal(out.exitCode, 0);
    assert.ok(!out.output.includes('s3cr3t'), '不该留下 token');
    assert.match(out.output, /alice:\*\*\*@example\.com/);
    assert.ok(out.output.length <= SETUP_OUTPUT_MAX, `输出应截到 ${SETUP_OUTPUT_MAX}，实际 ${out.output.length}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('准备命令：环境里没有 hub 的秘密，只有白名单 + 注入项', async () => {
  const cwd = await dir();
  try {
    const out = await runSetupScript({
      path: cwd,
      command: 'env | sort',
      timeoutMs: 5000,
      env: { AGENT_HUB_WORKTREE_PATH: cwd, HUB_TOKEN: 'should-not-leak' }
    });
    assert.equal(out.exitCode, 0);
    assert.match(out.output, /AGENT_HUB_WORKTREE_PATH=/);
    assert.doesNotMatch(out.output, /HUB_TOKEN/);
    assert.doesNotMatch(out.output, /HUB_WORKER_CREDENTIAL/);
    assert.doesNotMatch(out.output, /HUB_LOCAL_SECRET/);
    assert.doesNotMatch(out.output, /should-not-leak/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('setupEnv：白名单之外的一律不带', () => {
  const env = setupEnv({ AGENT_HUB_BRANCH: 'main', HUB_URL: 'ws://x' }, { PATH: '/bin', HOME: '/home/u', AWS_SECRET_ACCESS_KEY: 'leak', LANG: 'C.UTF-8' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/u', LANG: 'C.UTF-8', AGENT_HUB_BRANCH: 'main' });
});

test('tailOutput / scrubCredentials：截尾与凭据擦除', () => {
  assert.equal(tailOutput('abcdef', 4), 'cdef');
  assert.equal(scrubCredentials('git clone https://u:p4ssw0rd@host/x'), 'git clone https://u:***@host/x');
  assert.equal(scrubCredentials('12:30 没问题'), '12:30 没问题');
});
