import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  BUNDLE_REF_PREFIX,
  createProjectGitBundleImporter,
  projectGitBundleRef
} from './project-git-bundle-import.ts';
import type {
  ProjectGitBundleImportInput,
  ProjectGitBundleImportOptions,
  ProjectGitBundleImporter,
  ProjectGitBundleWorkdirCheck
} from './project-git-bundle-import.ts';

const AUTHOR_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0'
};

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: AUTHOR_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function rev(cwd: string, ref: string): string {
  try {
    return git(cwd, ['rev-parse', '-q', '--verify', '--end-of-options', ref]).trim();
  } catch {
    return '';
  }
}

function symref(cwd: string, ref: string): string {
  try {
    return git(cwd, ['symbolic-ref', '-q', ref]).trim();
  } catch {
    return '';
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function hasObject(cwd: string, sha: string): boolean {
  try {
    git(cwd, ['cat-file', '-e', sha]);
    return true;
  } catch {
    return false;
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Fixture {
  readonly base: string;
  readonly target: string;
  readonly origin: string;
  readonly source: string;
  readonly tipSha: string;
  readonly bundleBase64: string;
  readonly bundleSha256: string;
  readonly ref: string;
  input(overrides?: Partial<ProjectGitBundleImportInput>): ProjectGitBundleImportInput;
  importer(
    options?: ProjectGitBundleImportOptions,
    check?: ProjectGitBundleWorkdirCheck
  ): ProjectGitBundleImporter;
}

async function buildFixture(base: string): Promise<Fixture> {
  const seed = join(base, 'seed');
  await mkdir(seed);
  git(seed, ['init', '-q', '-b', 'main']);
  await writeFile(join(seed, 'README.md'), 'hello\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-qm', 'initial']);

  const origin = join(base, 'origin.git');
  git(base, ['clone', '--bare', '--quiet', seed, origin]);

  const target = join(base, 'target');
  git(base, ['clone', '--quiet', origin, target]);

  const source = join(base, 'source');
  git(base, ['clone', '--quiet', origin, source]);
  git(source, ['checkout', '-q', '-b', 'feature']);
  await writeFile(join(source, 'feature.txt'), 'feature\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-qm', 'feature']);
  const tipSha = git(source, ['rev-parse', 'HEAD']).trim();

  const bundlePath = join(base, 'feature.bundle');
  git(source, ['bundle', 'create', '--quiet', bundlePath, 'refs/heads/feature']);
  const bundleBytes = await readFile(bundlePath);
  const ref = `${BUNDLE_REF_PREFIX}project-1/${tipSha}`;

  const check: ProjectGitBundleWorkdirCheck = async (path) =>
    path === target || path.startsWith(`${target}/`) ? null : '目录不在允许范围';

  return {
    base,
    target,
    origin,
    source,
    tipSha,
    bundleBase64: bundleBytes.toString('base64'),
    bundleSha256: sha256(bundleBytes),
    ref,
    input(overrides = {}) {
      return {
        path: target,
        expectedUrl: origin,
        bundleBase64: bundleBytes.toString('base64'),
        bundleSha256: sha256(bundleBytes),
        tipSha,
        ref,
        ...overrides
      };
    },
    importer(options = {}, checkOverride) {
      return createProjectGitBundleImporter(checkOverride ?? check, {
        allowLocalOrigin: true,
        ...options
      });
    }
  };
}

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
  build: (base: string) => Promise<Fixture> = buildFixture
): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'agent-hub-bundle-test-')));
  try {
    await run(await build(base));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

type ImportResult = Awaited<ReturnType<ProjectGitBundleImporter['importBundle']>>;

function expectOk(result: ImportResult): {
  readonly ref: string;
  readonly tipSha: string;
  readonly alreadyPresent: boolean;
} {
  if (!result.ok) assert.fail(result.error.message);
  return result.value;
}

function expectError(result: ImportResult, code: string): string {
  if (result.ok) assert.fail('预期失败，实际成功');
  assert.equal(result.error.code, code, result.error.message);
  return result.error.message;
}

describe('project git bundle import', () => {
  it('必须显式提供目录授权回调，没有默认放行', () => {
    assert.throws(
      () => createProjectGitBundleImporter(undefined as unknown as ProjectGitBundleWorkdirCheck),
      /授权回调/
    );
  });

  it('导入自包含 bundle：只建一个专用 ref，HEAD / 分支 / index / 工作区不变', async () => {
    await withFixture(async (fixture) => {
      const importer = fixture.importer();
      await writeFile(join(fixture.target, 'local-untracked.txt'), 'keep me\n');
      const headBefore = rev(fixture.target, 'HEAD');
      const branchBefore = symref(fixture.target, 'HEAD');
      const statusBefore = git(fixture.target, ['status', '--porcelain=v1']);
      const remoteRefsBefore = git(fixture.target, [
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/remotes'
      ]);
      const readmeBefore = await readFile(join(fixture.target, 'README.md'), 'utf8');
      const indexPath = join(fixture.target, '.git', 'index');
      const indexBefore = await stat(indexPath);

      const outcome = expectOk(await importer.importBundle(fixture.input()));
      assert.equal(outcome.ref, fixture.ref);
      assert.equal(outcome.tipSha, fixture.tipSha);
      assert.equal(outcome.alreadyPresent, false);

      const indexAfter = await stat(indexPath);
      assert.equal(indexAfter.ino, indexBefore.ino);
      assert.equal(indexAfter.size, indexBefore.size);
      assert.equal(indexAfter.mtimeMs, indexBefore.mtimeMs);
      assert.equal(indexAfter.ctimeMs, indexBefore.ctimeMs);

      assert.equal(rev(fixture.target, 'HEAD'), headBefore);
      assert.equal(symref(fixture.target, 'HEAD'), branchBefore);
      assert.equal(git(fixture.target, ['status', '--porcelain=v1']), statusBefore);
      assert.equal(await readFile(join(fixture.target, 'README.md'), 'utf8'), readmeBefore);
      assert.equal(await readFile(join(fixture.target, 'local-untracked.txt'), 'utf8'), 'keep me\n');

      assert.equal(rev(fixture.target, fixture.ref), fixture.tipSha);
      assert.equal(git(fixture.target, ['cat-file', '-t', fixture.tipSha]).trim(), 'commit');
      assert.equal(await exists(join(fixture.target, '.git', 'FETCH_HEAD')), false);
      assert.equal(
        git(fixture.target, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes']),
        remoteRefsBefore
      );
      assert.equal(
        git(fixture.target, ['for-each-ref', '--format=%(refname)', 'refs/agent-hub']).trim(),
        fixture.ref
      );
      assert.equal(await exists(join(fixture.target, '.git', 'refs', 'agent-hub', 'verify')), false);
    });
  });

  it('同一个 ref 指向同一个 tip 时幂等，不重写 ref，也不动工作区', async () => {
    await withFixture(async (fixture) => {
      const importer = fixture.importer();
      const first = expectOk(await importer.importBundle(fixture.input()));
      assert.equal(first.alreadyPresent, false);

      const headBefore = rev(fixture.target, 'HEAD');
      const indexPath = join(fixture.target, '.git', 'index');
      const indexBefore = await stat(indexPath);

      const second = expectOk(await importer.importBundle(fixture.input()));
      assert.equal(second.alreadyPresent, true);
      assert.equal(second.ref, fixture.ref);
      assert.equal(rev(fixture.target, fixture.ref), fixture.tipSha);
      assert.equal(rev(fixture.target, 'HEAD'), headBefore);

      const indexAfter = await stat(indexPath);
      assert.equal(indexAfter.ino, indexBefore.ino);
      assert.equal(indexAfter.mtimeMs, indexBefore.mtimeMs);
      assert.equal(indexAfter.ctimeMs, indexBefore.ctimeMs);
    });
  });

  it('detached HEAD 下导入成功且 HEAD 仍停在原提交', async () => {
    await withFixture(async (fixture) => {
      git(fixture.target, ['checkout', '-q', '--detach']);
      const headBefore = rev(fixture.target, 'HEAD');
      assert.equal(symref(fixture.target, 'HEAD'), '');

      const outcome = expectOk(await fixture.importer().importBundle(fixture.input()));
      assert.equal(outcome.alreadyPresent, false);
      assert.equal(rev(fixture.target, 'HEAD'), headBefore);
      assert.equal(symref(fixture.target, 'HEAD'), '');
      assert.equal(rev(fixture.target, fixture.ref), fixture.tipSha);
    });
  });

  it('linked worktree / .git 间接指向时失败关闭，不导入任何对象或 ref', async () => {
    await withFixture(async (fixture) => {
      const worktree = join(fixture.base, 'linked-worktree');
      git(fixture.target, ['worktree', 'add', '-q', '-b', 'linked', worktree]);
      const mainHeadBefore = rev(fixture.target, 'HEAD');
      const headBefore = rev(worktree, 'HEAD');
      const refsBefore = git(worktree, ['for-each-ref', '--format=%(refname) %(objectname)']);

      const check: ProjectGitBundleWorkdirCheck = async (path) =>
        path === worktree ? null : '目录不在允许范围';
      const importer = createProjectGitBundleImporter(check, { allowLocalOrigin: true });
      const message = expectError(
        await importer.importBundle({ ...fixture.input(), path: worktree }),
        'invalid'
      );

      assert.match(message, /普通主工作区|linked worktree|\.git 文件/);
      assert.equal(rev(worktree, 'HEAD'), headBefore);
      assert.equal(rev(fixture.target, 'HEAD'), mainHeadBefore);
      assert.equal(
        git(worktree, ['for-each-ref', '--format=%(refname) %(objectname)']),
        refsBefore
      );
      assert.equal(rev(worktree, fixture.ref), '');
      assert.equal(hasObject(worktree, fixture.tipSha), false);
    });
  });

  it('仓库 .git 是符号链接时失败关闭，不导入', async () => {
    await withFixture(async (fixture) => {
      const gitDir = join(fixture.target, '.git');
      const realGitDir = join(fixture.target, '.git-real');
      await rename(gitDir, realGitDir);
      await symlink(realGitDir, gitDir, 'dir');

      const message = expectError(await fixture.importer().importBundle(fixture.input()), 'invalid');
      assert.match(message, /普通主工作区|\.git/);
      assert.equal(rev(fixture.target, fixture.ref), '');
    });
  });

  it('拒绝大小写 / 哈希 / base64 / ref 不合法的输入，且不写任何 ref', async () => {
    await withFixture(async (fixture) => {
      const importer = fixture.importer();
      const good = fixture.input();
      const headBefore = rev(fixture.target, 'HEAD');
      const refsBefore = git(fixture.target, ['for-each-ref', '--format=%(refname)']);
      const cases: Array<[string, Partial<ProjectGitBundleImportInput>]> = [
        ['大写 bundleSha256', { bundleSha256: good.bundleSha256.toUpperCase() }],
        ['错误 bundleSha256', { bundleSha256: '0'.repeat(64) }],
        ['非 base64', { bundleBase64: 'not base64!' }],
        ['截断 base64', { bundleBase64: good.bundleBase64.slice(0, -1) }],
        ['多余 padding', { bundleBase64: `${good.bundleBase64}=` }],
        ['大写 tipSha', { tipSha: good.tipSha.toUpperCase() }],
        ['ref 不在专用命名空间', { ref: `refs/heads/x/${good.tipSha}` }],
        ['ref 末尾 SHA 不匹配', { ref: `${BUNDLE_REF_PREFIX}project-1/${'1'.repeat(40)}` }],
        ['ref 含非法 id', { ref: `${BUNDLE_REF_PREFIX}../${good.tipSha}` }],
        ['path 不是绝对路径', { path: 'target' }],
        ['expectedUrl 不是 HTTPS 也不是本地路径', { expectedUrl: 'ssh://example.test/repo.git' }]
      ];

      for (const [name, patch] of cases) {
        const message = expectError(await importer.importBundle({ ...good, ...patch }), 'invalid');
        assert.notEqual(message, '', name);
      }

      assert.equal(rev(fixture.target, 'HEAD'), headBefore);
      assert.equal(git(fixture.target, ['for-each-ref', '--format=%(refname)']), refsBefore);
    });
  });

  it('超过 maxBundleBytes 时在解码前后都拒绝', async () => {
    await withFixture(async (fixture) => {
      const importer = fixture.importer({ maxBundleBytes: 8 });
      const headBefore = rev(fixture.target, 'HEAD');
      const message = expectError(await importer.importBundle(fixture.input()), 'invalid');
      assert.match(message, /大小上限/);
      assert.equal(rev(fixture.target, fixture.ref), '');
      assert.equal(rev(fixture.target, 'HEAD'), headBefore);
    });
  });

  it('8 MiB 的规范 base64 不会耗尽正则栈', async () => {
    await withFixture(async (fixture) => {
      const bundleBase64 = Buffer.alloc(8 * 1024 * 1024).toString('base64');
      const message = expectError(await fixture.importer({ maxBundleBytes: 8 * 1024 * 1024 }).importBundle({
        ...fixture.input(), bundleBase64, bundleSha256: '0'.repeat(64)
      }), 'invalid');
      assert.match(message, /sha256/);
    });
  });

  it('显式 scratchRoot：成功与失败后都清空临时校验目录', async () => {
    await withFixture(async (fixture) => {
      const scratchRoot = join(fixture.base, 'scratch-root');
      await mkdir(scratchRoot);
      // 尾部 `/` 允许，但内部仍按真实路径使用。
      const importer = fixture.importer({ scratchRoot: `${scratchRoot}/` });

      const outcome = expectOk(await importer.importBundle(fixture.input()));
      assert.equal(outcome.alreadyPresent, false);
      assert.deepEqual(await readdir(scratchRoot), []);
      assert.equal(rev(fixture.target, fixture.ref), fixture.tipSha);

      const other = '2'.repeat(40);
      const failed = await importer.importBundle(
        fixture.input({
          tipSha: other,
          ref: `${BUNDLE_REF_PREFIX}project-1/${other}`
        })
      );
      expectError(failed, 'invalid');
      assert.deepEqual(await readdir(scratchRoot), []);
      assert.equal(rev(fixture.target, fixture.ref), fixture.tipSha);
      assert.equal(hasObject(fixture.target, other), false);
    });
  });

  it('显式 scratchRoot 不存在 / 是文件 / 是相对路径 / 经过符号链接时都拒绝，不回退 tmpdir', async () => {
    await withFixture(async (fixture) => {
      const headBefore = rev(fixture.target, 'HEAD');
      const refsBefore = git(fixture.target, ['for-each-ref', '--format=%(refname)']);
      const input = fixture.input();

      const missing = join(fixture.base, 'missing-scratch');
      const missingMessage = expectError(
        await fixture.importer({ scratchRoot: missing }).importBundle(input),
        'invalid'
      );
      assert.match(missingMessage, /scratchRoot/);
      assert.equal(await exists(missing), false);

      const fileRoot = join(fixture.base, 'scratch-file');
      await writeFile(fileRoot, 'not a directory\n');
      const fileMessage = expectError(
        await fixture.importer({ scratchRoot: fileRoot }).importBundle(input),
        'invalid'
      );
      assert.match(fileMessage, /scratchRoot/);
      assert.equal(await readFile(fileRoot, 'utf8'), 'not a directory\n');

      const relativeMessage = expectError(
        await fixture.importer({ scratchRoot: 'relative-scratch' }).importBundle(input),
        'invalid'
      );
      assert.match(relativeMessage, /scratchRoot/);

      const realRoot = join(fixture.base, 'scratch-real');
      await mkdir(realRoot);
      const linkRoot = join(fixture.base, 'scratch-link');
      await symlink(realRoot, linkRoot, 'dir');
      const linkMessage = expectError(
        await fixture.importer({ scratchRoot: linkRoot }).importBundle(input),
        'invalid'
      );
      assert.match(linkMessage, /符号链接/);

      assert.equal(rev(fixture.target, fixture.ref), '');
      assert.equal(rev(fixture.target, 'HEAD'), headBefore);
      assert.equal(git(fixture.target, ['for-each-ref', '--format=%(refname)']), refsBefore);
    });
  });

  it('显式 scratchRoot 不可读写时按 unavailable 拒绝', async (t) => {
    if (process.getuid?.() === 0) {
      t.skip('root 不受 chmod 权限位限制');
      return;
    }
    await withFixture(async (fixture) => {
      const locked = join(fixture.base, 'scratch-locked');
      await mkdir(locked);
      await chmod(locked, 0o000);
      try {
        const message = expectError(
          await fixture.importer({ scratchRoot: locked }).importBundle(fixture.input()),
          'unavailable'
        );
        assert.match(message, /不可读写/);
        assert.equal(rev(fixture.target, fixture.ref), '');
      } finally {
        await chmod(locked, 0o700);
      }
    });
  });

  it('bundle 没有把 tipSha 暴露成 ref 时拒绝', async () => {
    await withFixture(async (fixture) => {
      const other = '2'.repeat(40);
      const input = fixture.input({
        tipSha: other,
        ref: `${BUNDLE_REF_PREFIX}project-1/${other}`
      });
      const message = expectError(await fixture.importer().importBundle(input), 'invalid');
      assert.match(message, /tipSha/);
      assert.equal(rev(fixture.target, input.ref), '');
    });
  });

  it('只声明 tag ref 的 bundle 不满足“唯一分支 tip”要求', async () => {
    await withFixture(async (fixture) => {
      git(fixture.source, ['tag', '-a', '-m', 'annotated', 'v1']);
      const tagSha = git(fixture.source, ['rev-parse', 'v1']).trim();
      const tagBundlePath = join(fixture.base, 'tag.bundle');
      git(fixture.source, ['bundle', 'create', '--quiet', tagBundlePath, 'refs/tags/v1']);
      const tagBytes = await readFile(tagBundlePath);

      const input = fixture.input({
        tipSha: tagSha,
        ref: `${BUNDLE_REF_PREFIX}project-1/${tagSha}`,
        bundleBase64: tagBytes.toString('base64'),
        bundleSha256: sha256(tagBytes)
      });
      const message = expectError(await fixture.importer().importBundle(input), 'invalid');
      assert.match(message, /refs\/heads|一个分支 tip/);
      assert.equal(rev(fixture.target, input.ref), '');
    });
  });

  it('bundle 声明多个分支 tip 时拒绝，不从中挑一个', async () => {
    await withFixture(async (fixture) => {
      const multiPath = join(fixture.base, 'multi.bundle');
      git(fixture.source, [
        'bundle',
        'create',
        '--quiet',
        multiPath,
        'refs/heads/main',
        'refs/heads/feature'
      ]);
      const multiBytes = await readFile(multiPath);
      const input = fixture.input({
        bundleBase64: multiBytes.toString('base64'),
        bundleSha256: sha256(multiBytes)
      });

      const message = expectError(await fixture.importer().importBundle(input), 'invalid');
      assert.match(message, /一个分支 tip/);
      assert.equal(rev(fixture.target, input.ref), '');
    });
  });

  it('thin bundle（缺前置提交）在临时空仓库校验阶段被拒', async () => {
    await withFixture(async (fixture) => {
      const thinPath = join(fixture.base, 'thin.bundle');
      git(fixture.source, ['bundle', 'create', '--quiet', thinPath, 'main..feature']);
      const thinBytes = await readFile(thinPath);

      const input = fixture.input({
        bundleBase64: thinBytes.toString('base64'),
        bundleSha256: sha256(thinBytes)
      });
      const message = expectError(await fixture.importer().importBundle(input), 'invalid');
      assert.match(message, /校验失败/);
      assert.doesNotMatch(message, /fatal:|error:|Repository lacks|prerequisite/i);
      assert.equal(rev(fixture.target, input.ref), '');
    });
  });

  it('仓库配置 objects/info/alternates 时拒绝', async () => {
    await withFixture(async (fixture) => {
      const infoDir = join(fixture.target, '.git', 'objects', 'info');
      await mkdir(infoDir, { recursive: true });
      await writeFile(join(infoDir, 'alternates'), '/tmp/somewhere/objects\n');

      const message = expectError(await fixture.importer().importBundle(fixture.input()), 'invalid');
      assert.match(message, /alternate/);
      assert.equal(rev(fixture.target, fixture.ref), '');
      assert.equal(hasObject(fixture.target, fixture.tipSha), false);
    });
  });

  it('仓库配置 promisor remote 时拒绝', async () => {
    await withFixture(async (fixture) => {
      git(fixture.target, ['config', 'remote.origin.promisor', 'true']);

      const message = expectError(await fixture.importer().importBundle(fixture.input()), 'invalid');
      assert.match(message, /promisor/);
      assert.equal(rev(fixture.target, fixture.ref), '');
    });
  });

  it('目录授权回调拒绝时失败关闭', async () => {
    await withFixture(async (fixture) => {
      const importer = fixture.importer({}, async () => '目录未授权');
      const message = expectError(await importer.importBundle(fixture.input()), 'invalid');
      assert.match(message, /未授权/);
      assert.equal(rev(fixture.target, fixture.ref), '');
    });
  });

  it('授权回调抛错时按 unavailable 失败关闭', async () => {
    await withFixture(async (fixture) => {
      const importer = fixture.importer({}, async () => {
        throw new Error('boom');
      });
      const message = expectError(await importer.importBundle(fixture.input()), 'unavailable');
      assert.match(message, /授权检查失败/);
      assert.equal(rev(fixture.target, fixture.ref), '');
    });
  });

  it('symlink 把 realpath 带出授权根时拒绝', async () => {
    await withFixture(async (fixture) => {
      const allowed = join(fixture.base, 'allowed');
      await mkdir(allowed);
      const link = join(allowed, 'link');
      await symlink(fixture.target, link, 'dir');

      // 词法检查放行 link，模块必须再按 realpath 检查一次。
      const check: ProjectGitBundleWorkdirCheck = async (path) =>
        path === allowed || path.startsWith(`${allowed}/`) ? null : '目录不在允许范围';
      const importer = createProjectGitBundleImporter(check, { allowLocalOrigin: true });

      const message = expectError(await importer.importBundle({ ...fixture.input(), path: link }), 'invalid');
      assert.match(message, /允许范围/);
      assert.equal(rev(fixture.target, fixture.ref), '');
    });
  });

  it('path 是仓库子目录或不存在时拒绝', async () => {
    await withFixture(async (fixture) => {
      const subdir = join(fixture.target, 'sub');
      await mkdir(subdir);
      const importer = fixture.importer();

      const subMessage = expectError(await importer.importBundle({ ...fixture.input(), path: subdir }), 'invalid');
      assert.match(subMessage, /根目录/);
      expectError(await importer.importBundle({ ...fixture.input(), path: join(fixture.target, 'missing') }), 'invalid');
    });
  });

  it('origin 与 expectedUrl 不一致时拒绝', async () => {
    await withFixture(async (fixture) => {
      git(fixture.target, ['remote', 'set-url', 'origin', join(fixture.base, 'other.git')]);
      const message = expectError(await fixture.importer().importBundle(fixture.input()), 'invalid');
      assert.match(message, /不一致/);
      assert.equal(rev(fixture.target, fixture.ref), '');
    });
  });

  it('origin 的 fetch / push 规范地址不一致时拒绝', async () => {
    await withFixture(async (fixture) => {
      const fetchUrl = 'https://git.example.test/team/repo.git';
      const pushUrl = 'https://other.example.test/team/repo.git';
      git(fixture.target, ['remote', 'set-url', 'origin', fetchUrl]);
      git(fixture.target, ['remote', 'set-url', '--push', 'origin', pushUrl]);

      const input = fixture.input({ expectedUrl: fetchUrl });
      const message = expectError(await fixture.importer().importBundle(input), 'invalid');
      assert.match(message, /不一致/);
      assert.equal(rev(fixture.target, input.ref), '');
    });
  });

  it('仓库本地 insteadOf 改写 origin 时拒绝', async () => {
    await withFixture(async (fixture) => {
      const other = join(fixture.base, 'other.git');
      git(fixture.target, ['config', `url.${other}.insteadOf`, fixture.origin]);
      const message = expectError(await fixture.importer().importBundle(fixture.input()), 'invalid');
      assert.match(message, /insteadOf/);
      assert.equal(rev(fixture.target, fixture.ref), '');
    });
  });

  it('专用 ref 已存在且指向别的提交时 conflict，不覆盖', async () => {
    await withFixture(async (fixture) => {
      const occupied = rev(fixture.target, 'HEAD');
      git(fixture.target, ['update-ref', fixture.ref, occupied]);
      assert.equal(rev(fixture.target, fixture.ref), occupied);

      const message = expectError(await fixture.importer().importBundle(fixture.input()), 'conflict');
      assert.match(message, /不同的提交/);
      assert.equal(rev(fixture.target, fixture.ref), occupied);
      assert.equal(hasObject(fixture.target, fixture.tipSha), false);
    });
  });

  it('专用 ref 是符号引用时拒绝，不跟随到目标分支', async () => {
    await withFixture(async (fixture) => {
      git(fixture.target, ['symbolic-ref', fixture.ref, 'refs/heads/main']);
      const headBefore = rev(fixture.target, 'HEAD');

      const message = expectError(await fixture.importer().importBundle(fixture.input()), 'invalid');
      assert.match(message, /符号引用/);
      assert.equal(symref(fixture.target, fixture.ref), 'refs/heads/main');
      assert.equal(rev(fixture.target, 'refs/heads/main'), headBefore);
      assert.equal(hasObject(fixture.target, fixture.tipSha), false);
    });
  });

  it('忽略 ambient Git 配置、GIT_CONFIG_*、凭据 askpass 与仓库 hook', async () => {
    await withFixture(async (fixture) => {
      const marker = join(fixture.base, 'marker.log');
      const fakeHome = join(fixture.base, 'fake-home');
      await mkdir(fakeHome);
      await writeFile(
        join(fakeHome, '.gitconfig'),
        `[url "file:///nonexistent/"]\n\tinsteadOf = ${fixture.origin}\n`
      );

      const askpass = join(fixture.base, 'askpass.sh');
      await writeFile(askpass, `#!/bin/sh\necho askpass >> ${marker}\n`);
      await chmod(askpass, 0o755);

      const hookDir = join(fixture.base, 'evil-hooks');
      await mkdir(hookDir);
      const hook = join(hookDir, 'reference-transaction');
      await writeFile(hook, `#!/bin/sh\necho hook >> ${marker}\n`);
      await chmod(hook, 0o755);
      git(fixture.target, ['config', 'core.hooksPath', hookDir]);

      const saved = {
        HOME: process.env.HOME,
        GIT_ASKPASS: process.env.GIT_ASKPASS,
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
        GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
        GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
        GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0
      };
      process.env.HOME = fakeHome;
      process.env.GIT_ASKPASS = askpass;
      process.env.GIT_SSH_COMMAND = askpass;
      process.env.GIT_CONFIG_GLOBAL = join(fakeHome, '.gitconfig');
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'url.file:///nonexistent/.insteadOf';
      process.env.GIT_CONFIG_VALUE_0 = fixture.origin;
      try {
        const outcome = expectOk(await fixture.importer().importBundle(fixture.input()));
        assert.equal(outcome.alreadyPresent, false);
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }

      assert.equal(await exists(marker), false);
      assert.equal(rev(fixture.target, fixture.ref), fixture.tipSha);
      assert.equal(rev(fixture.target, 'HEAD'), rev(fixture.target, 'refs/heads/main'));
    });
  });

  it('HTTPS expectedUrl 末尾斜杠按规范地址匹配；成功本身证明没有联网', async () => {
    await withFixture(async (fixture) => {
      git(fixture.target, ['remote', 'set-url', 'origin', 'https://example.test/team/repo.git']);
      const importer = fixture.importer({ allowLocalOrigin: false });
      const outcome = expectOk(
        await importer.importBundle({
          ...fixture.input(),
          expectedUrl: 'https://example.test/team/repo.git/'
        })
      );
      assert.equal(outcome.alreadyPresent, false);
      assert.equal(rev(fixture.target, fixture.ref), fixture.tipSha);

      const other = expectError(
        await importer.importBundle({
          ...fixture.input(),
          expectedUrl: 'https://example.test/team/other.git'
        }),
        'invalid'
      );
      assert.match(other, /不一致/);
    });
  });

  it('projectGitBundleRef 只接受合法 id 和小写 SHA-1', () => {
    const tip = 'a'.repeat(40);
    assert.equal(projectGitBundleRef('project-1', tip), `${BUNDLE_REF_PREFIX}project-1/${tip}`);
    assert.equal(projectGitBundleRef('../project', tip), null);
    assert.equal(projectGitBundleRef('project-1', tip.toUpperCase()), null);
  });
});
