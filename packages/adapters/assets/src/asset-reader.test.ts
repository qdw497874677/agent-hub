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
