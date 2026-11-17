import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyGitFailure, createAssetReader, isPathInside, parseSkillFrontmatter, redactGitStderr } from './asset-reader.ts';

test('frontmatter：取 name / description，缺了或坏 YAML 报错', () => {
  assert.deepEqual(parseSkillFrontmatter('---\nname: pdf\ndescription: >\n  Read PDFs\n---\nbody'), {
    ok: true,
    value: { name: 'pdf', description: 'Read PDFs' }
  });
  assert.equal(parseSkillFrontmatter('# no frontmatter').ok, false);
  assert.equal(parseSkillFrontmatter('---\nname: [oops\n---\n').ok, false);
});

test('git：协议 file:// 被拒（只许远端仓库）', async () => {
  const reader = createAssetReader({ gitTimeoutMs: 10_000 });
  const repo = mkdtempSync(join(tmpdir(), 'asset-repo-'));
  try {
    execFileSync('git', ['init', '-q', repo]);
    const got = await reader.scanGit(`file://${repo}`, null);
    assert.equal(got.ok, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('git：扫描候选、读技能目录（跳过符号链接）、读指令文件、diff', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'asset-repo-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, 'skills/greeter/scripts'), { recursive: true });
  writeFileSync(join(repo, 'skills/greeter/SKILL.md'), '---\nname: greeter\ndescription: Greets\n---\nSay hi\n');
  writeFileSync(join(repo, 'skills/greeter/scripts/a.txt'), 'x');
  symlinkSync('/etc/hostname', join(repo, 'skills/greeter/escape'));
  writeFileSync(join(repo, 'AGENTS.md'), '# House rules\nBe terse.\n');
  const run = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=t', ...args]);
  run('init', '-q', '-b', 'main');
  run('add', '-A');
  run('commit', '-q', '-m', 'init');
  const reader = createAssetReader({ gitTimeoutMs: 10_000, allowLocalRepos: true });
  const url = `file://${repo}`;
  const scan = await reader.scanGit(url, null);
  assert.ok(scan.ok, scan.ok ? '' : scan.error.message);
  assert.match(scan.value.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    scan.value.candidates.map((c) => [c.kind, c.path, c.name, c.description]),
    [['instruction', 'AGENTS.md', 'agents', 'House rules'], ['skill', 'skills/greeter', 'greeter', 'Greets']]
  );
  const skill = await reader.readGit(url, 'main', 'skills/greeter', 'skill');
  assert.ok(skill.ok);
  assert.deepEqual(skill.value.files.map((f) => f.path).sort(), ['SKILL.md', 'scripts/a.txt']);
  const instr = await reader.readGit(url, null, 'AGENTS.md', 'instruction');
  assert.ok(instr.ok);
  assert.deepEqual(instr.value.files.map((f) => f.path), ['AGENTS.md']);
  assert.equal((await reader.readGit(url, null, '../etc', 'skill')).ok, false);
  assert.equal((await reader.readGit(url, null, 'nope', 'skill')).ok, false);
  assert.equal((await reader.readGit(url, '--upload-pack=x', '', 'skill')).ok, false);
  assert.match(reader.diffText('SKILL.md', 'a\n', 'b\n'), /-a\n\+b/);
});

test('git：中间目录符号链接指到检出目录外 → 导入失败，不读内容（#222）', async (t) => {
  const outside = mkdtempSync(join(tmpdir(), 'asset-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'SKILL.md'), '---\nname: evil\ndescription: stolen\n---\nsecret\n');
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');

  const repo = mkdtempSync(join(tmpdir(), 'asset-repo-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, 'skills/good/nested'), { recursive: true });
  writeFileSync(join(repo, 'skills/good/SKILL.md'), '---\nname: good\ndescription: ok\n---\nhi\n');
  writeFileSync(join(repo, 'skills/good/nested/a.txt'), 'x');
  // 中间目录是符号链接：lstat 会跟随它，只看 Dirent 拦不住
  symlinkSync(outside, join(repo, 'skills/evil'));
  // 深层目录里的符号链接（现有行为：跳过）
  symlinkSync(outside, join(repo, 'skills/good/escape'));
  const run = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=t', ...args]);
  run('init', '-q', '-b', 'main');
  run('add', '-A');
  run('commit', '-q', '-m', 'init');

  const reader = createAssetReader({ gitTimeoutMs: 10_000, allowLocalRepos: true });
  const url = `file://${repo}`;
  const evil = await reader.readGit(url, 'main', 'skills/evil', 'skill');
  assert.equal(evil.ok, false, '中间目录越界应拒绝');
  const good = await reader.readGit(url, 'main', 'skills/good', 'skill');
  assert.ok(good.ok);
  assert.deepEqual(good.value.files.map((f) => f.path).sort(), ['SKILL.md', 'nested/a.txt']);
  const text = good.value.files.map((f) => new TextDecoder().decode(f.data)).join('\n');
  assert.equal(text.includes('TOP SECRET'), false, '检出目录外的内容不应被读到');
});

test('git：稀疏检出与大小上限（单文件 1 MB / 累计 4 MB）', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'asset-repo-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, 'skills/big'), { recursive: true });
  mkdirSync(join(repo, 'skills/huge'), { recursive: true });
  mkdirSync(join(repo, 'other'), { recursive: true });
  writeFileSync(join(repo, 'skills/big/SKILL.md'), '---\nname: big\ndescription: Many files\n---\nx\n');
  // 每个文件 < 1 MB，但合计 > 4 MB：导入要在读完整个目录前中止
  for (let i = 0; i < 5; i += 1) writeFileSync(join(repo, `skills/big/part-${i}.bin`), 'x'.repeat(900 * 1024));
  // 超过单文件上限的 SKILL.md：扫描不读它，导入时给出中文错误
  writeFileSync(join(repo, 'skills/huge/SKILL.md'), `---\nname: huge\ndescription: ${'y'.repeat(1100 * 1024)}\n---\n`);
  writeFileSync(join(repo, 'other/big.txt'), 'z'.repeat(1200 * 1024));
  const run = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=t', ...args]);
  run('init', '-q', '-b', 'main');
  run('add', '-A');
  run('commit', '-q', '-m', 'init');

  const reader = createAssetReader({ gitTimeoutMs: 20_000, allowLocalRepos: true });
  const url = `file://${repo}`;
  const scan = await reader.scanGit(url, null);
  assert.ok(scan.ok, scan.ok ? '' : scan.error.message);
  const huge = scan.value.candidates.find((c) => c.path === 'skills/huge');
  assert.ok(huge, '超大的 SKILL.md 仍然列成候选（导入时再报错）');
  assert.equal(huge.description, '');

  const total = await reader.readGit(url, null, 'skills/big', 'skill');
  assert.equal(total.ok, false);
  assert.match(total.ok ? '' : total.error.message, /文件总大小超过 4 MB/);

  const single = await reader.readGit(url, null, 'other/big.txt', 'instruction');
  assert.equal(single.ok, false);
  assert.match(single.ok ? '' : single.error.message, /文件太大/);

  const oversized = await reader.readGit(url, null, 'skills/huge', 'skill');
  assert.equal(oversized.ok, false);
  assert.match(oversized.ok ? '' : oversized.error.message, /文件太大/);

  // 稀疏检出只拉目标目录：同一仓库里别的目录再大也不影响这一项
  mkdirSync(join(repo, 'skills/small'), { recursive: true });
  writeFileSync(join(repo, 'skills/small/SKILL.md'), '---\nname: small\ndescription: Tiny\n---\nhi\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'small');
  const small = await reader.readGit(url, null, 'skills/small', 'skill');
  assert.ok(small.ok, small.ok ? '' : small.error.message);
  assert.deepEqual(small.value.files.map((f) => f.path), ['SKILL.md']);
});

test('git：cleanPath 拒绝空路径 / 绝对路径 / .. 段', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'asset-repo-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, 'skills/greeter'), { recursive: true });
  writeFileSync(join(repo, 'skills/greeter/SKILL.md'), '---\nname: greeter\ndescription: Greets\n---\nhi\n');
  const run = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=t', ...args]);
  run('init', '-q', '-b', 'main');
  run('add', '-A');
  run('commit', '-q', '-m', 'init');
  const reader = createAssetReader({ gitTimeoutMs: 10_000, allowLocalRepos: true });
  const url = `file://${repo}`;
  for (const path of ['', '/etc', 'skills/../..', '..', 'a\\b']) {
    assert.equal((await reader.readGit(url, 'main', path, 'skill')).ok, false, path);
  }
});

test('git：干净环境（不借 HOME / SSH agent / 代理，HOME 临时且导入后删除）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-git-'));
  const capture = join(dir, 'env.txt');
  const bin = join(dir, 'git');
  writeFileSync(bin, `#!/bin/sh\nenv > ${JSON.stringify(capture)}\nexit 1\n`, { mode: 0o755 });
  const savedHome = process.env['HOME'];
  const savedSock = process.env['SSH_AUTH_SOCK'];
  process.env['HOME'] = '/home/real-user';
  process.env['SSH_AUTH_SOCK'] = '/tmp/agent.sock';
  process.env['HTTP_PROXY'] = 'http://proxy.local:3128';
  try {
    const reader = createAssetReader({ git: bin });
    const got = await reader.scanGit('https://github.com/x/y.git', null);
    assert.equal(got.ok, false);
    assert.equal(!got.ok && got.error.message, '克隆失败（其它）', '调用者只看到分类');
  } finally {
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    if (savedSock === undefined) delete process.env['SSH_AUTH_SOCK'];
    else process.env['SSH_AUTH_SOCK'] = savedSock;
    delete process.env['HTTP_PROXY'];
  }
  const env: Record<string, string> = {};
  for (const line of readFileSync(capture, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  assert.notEqual(env['HOME'], '/home/real-user');
  assert.match(env['HOME'] ?? '', /hub-asset-home-/);
  assert.equal(existsSync(env['HOME'] ?? ''), false, '导入结束应删掉临时 HOME');
  assert.equal(env['SSH_AUTH_SOCK'], undefined);
  assert.equal(env['GIT_ASKPASS'], undefined);
  assert.equal(env['HTTP_PROXY'], undefined);
  assert.equal(env['GIT_CONFIG_NOSYSTEM'], '1');
  assert.equal(env['GIT_CONFIG_GLOBAL'], '/dev/null');
  assert.equal(env['GIT_TERMINAL_PROMPT'], '0');
  assert.equal(env['GIT_CONFIG_KEY_0'], 'http.followRedirects');
  assert.equal(env['GIT_CONFIG_VALUE_0'], 'false');
  assert.match(env['GIT_SSH_COMMAND'] ?? '', /BatchMode=yes/);
  assert.doesNotMatch(env['GIT_SSH_COMMAND'] ?? '', /accept-new/);
  rmSync(dir, { recursive: true, force: true });
});

test('git 错误：分类映射与 stderr 抹除', () => {
  assert.equal(classifyGitFailure('fatal: Authentication failed for https://github.com/x/y.git'), '认证失败');
  assert.equal(classifyGitFailure('git@github.com: Permission denied (publickey).'), '认证失败');
  assert.equal(classifyGitFailure('ssh: connect to host github.com port 22: Connection timed out'), '主机不可达');
  assert.equal(classifyGitFailure('fatal: unable to access: Could not resolve host: github.com'), '主机不可达');
  assert.equal(classifyGitFailure("fatal: couldn't find remote ref nope"), '分支不存在');
  assert.equal(classifyGitFailure('fatal: something odd happened'), '其它');
  assert.equal(
    redactGitStderr('fatal: https://bob:tok3n@github.com/x/y.git 认证失败'),
    'fatal: https://***@github.com/x/y.git 认证失败'
  );
  // 私有仓库令牌走请求头：stderr 里可能原样出现，也要抹掉。
  assert.equal(
    redactGitStderr('http.extraheader=Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hwX3NlY3JldA=='),
    'http.extraheader=*** Basic ***'
  );
  assert.equal(redactGitStderr('Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hwX3NlY3JldA=='), 'Authorization: Basic ***');
  assert.equal(redactGitStderr('fatal: x-access-token:ghp_secret rejected'), 'fatal: x-access-token:*** rejected');
  assert.equal(isPathInside('/a/b', '/a/bc'), false);
  assert.equal(isPathInside('/a/b', '/a/b/c'), true);
  assert.equal(isPathInside('/a/b', '/a/b'), true);
});

test('frontmatter：name / description 类型不对、SKILL.md 不是 UTF-8，给出中文原因', () => {
  const bad = parseSkillFrontmatter('---\nname: [a, b]\ndescription: x\n---\n');
  assert.equal(!bad.ok && bad.error.message, 'SKILL.md 的 frontmatter 里 name 必须是一行文字');
  const badDesc = parseSkillFrontmatter('---\nname: a\ndescription: { x: 1 }\n---\n');
  assert.equal(!badDesc.ok && badDesc.error.message, 'SKILL.md 的 frontmatter 里 description 必须是文字');
  const reader = createAssetReader();
  const latin = reader.describe('skill', [{ path: 'SKILL.md', data: new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe]) }]);
  assert.equal(!latin.ok && latin.error.message, 'SKILL.md 不是 UTF-8 文本');
});
