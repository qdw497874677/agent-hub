import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetReader, parseSkillFrontmatter } from './asset-reader.ts';

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

test('frontmatter：name / description 类型不对、SKILL.md 不是 UTF-8，给出中文原因', () => {
  const bad = parseSkillFrontmatter('---\nname: [a, b]\ndescription: x\n---\n');
  assert.equal(!bad.ok && bad.error.message, 'SKILL.md 的 frontmatter 里 name 必须是一行文字');
  const badDesc = parseSkillFrontmatter('---\nname: a\ndescription: { x: 1 }\n---\n');
  assert.equal(!badDesc.ok && badDesc.error.message, 'SKILL.md 的 frontmatter 里 description 必须是文字');
  const reader = createAssetReader();
  const latin = reader.describe('skill', [{ path: 'SKILL.md', data: new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe]) }]);
  assert.equal(!latin.ok && latin.error.message, 'SKILL.md 不是 UTF-8 文本');
});
