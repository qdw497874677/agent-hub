import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  // HOME 不在白名单：真实 home 里有 .npmrc/.gitconfig/云凭据，执行时由 runSetupScript 换成一次性空目录。
  assert.deepEqual(env, { PATH: '/bin', LANG: 'C.UTF-8', AGENT_HUB_BRANCH: 'main' });
});

test('tailOutput / scrubCredentials：截尾与凭据擦除', () => {
  assert.equal(tailOutput('abcdef', 4), 'cdef');
  assert.equal(scrubCredentials('git clone https://u:p4ssw0rd@host/x'), 'git clone https://u:***@host/x');
  assert.equal(scrubCredentials('12:30 没问题'), '12:30 没问题');
  assert.equal(scrubCredentials('key sk-abcdefghijklmnop in log'), 'key sk-*** in log');
  assert.equal(scrubCredentials('token ghp_abcdefghijklmnopqrst in log'), 'token gh*_*** in log');
  assert.equal(scrubCredentials('AWS AKIAABCDEFGHIJKLMNOP used'), 'AWS AKIA*** used');
  assert.equal(scrubCredentials('authorization: Bearer abcdefghijklmnopqrst'), 'authorization: Bearer ***');
  assert.equal(scrubCredentials('OPENAI_API_KEY=sk-abcdefghijklmnop'), 'OPENAI_API_KEY=***');
  assert.equal(scrubCredentials('DB_PASSWORD=hunter2 rest'), 'DB_PASSWORD=*** rest');
});

test('runSetupScript：HOME 是一次性空目录，缓存也在里面，跑完删掉（#227）', async () => {
  const { existsSync } = await import('node:fs');
  const dir = await mkdtemp(join(tmpdir(), 'ah-setup-test-'));
  const out = await runSetupScript({
    path: dir,
    command: 'echo "$HOME" "$npm_config_cache" "$CARGO_HOME" > home.txt; touch "$HOME/marker"',
    timeoutMs: 10_000
  });
  assert.equal(out.exitCode, 0, out.output);
  const seen = (await readFile(join(dir, 'home.txt'), 'utf8')).trim().split(' ');
  const home = seen[0]!;
  assert.match(home, /agent-hub-setup-home-/);
  assert.equal(seen[1], join(home, '.npm'));
  assert.equal(seen[2], join(home, '.cargo'));
  for (let i = 0; i < 40 && existsSync(home); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(existsSync(home), false, '跑完要删掉一次性 HOME');
  await rm(dir, { recursive: true, force: true });
});

test('setupEnv：extras 只能改 PATH，HUB_ 秘密一个都带不进去（大小写也不放过）', () => {
  const env = setupEnv(
    {
      PATH: '/custom/bin:/bin',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      AGENT_HUB_BRANCH: 'main',
      HUB_TOKEN: 'leak-1',
      HUB_URL: 'ws://leak',
      hub_local_secret: 'leak-2',
      Hub_Worker_Credential: 'leak-3'
    },
    { PATH: '/usr/bin', SHELL: '/bin/sh', LANG: 'C.UTF-8', TERM: 'dumb' }
  );
  assert.equal(env.PATH, '/custom/bin:/bin', 'PATH 可以由上游追加');
  assert.equal(env.SHELL, '/bin/sh', 'SHELL 不许被覆盖');
  assert.equal(env.LANG, 'C.UTF-8', 'LANG 不许被覆盖');
  assert.equal(env.TERM, 'dumb', 'TERM 不许被覆盖');
  assert.equal(env.AGENT_HUB_BRANCH, 'main');
  for (const name of Object.keys(env)) assert.doesNotMatch(name, /^hub_/i, `不该出现 ${name}`);
  assert.ok(!Object.values(env).some((value) => value.startsWith('leak-')), '不该带进秘密值');
});

test('scrubCredentials：glpat、短 bearer、数字开头的 user:pass@', () => {
  assert.equal(scrubCredentials('token glpat-abcdefghij1234567890 in log'), 'token glpat-*** in log');
  assert.equal(scrubCredentials('authorization: Bearer abc12345'), 'authorization: Bearer ***');
  assert.equal(scrubCredentials('https://9alice:s3cr3t@gitlab.example.com/x'), 'https://9alice:***@gitlab.example.com/x');
  assert.equal(scrubCredentials('git@127.1:repo.git'), 'git@127.1:repo.git', '正常内容不要误伤');
});
