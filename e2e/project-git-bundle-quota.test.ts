import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENABLED = process.env.HUB_TEST_BWRAP_QUOTA === '1';
const BWRAP = '/usr/bin/bwrap';
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const MODULE = join(REPO, 'packages/node-gateway/src/project-git-bundle-import.ts');

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

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function skipReason(): string | false {
  if (!ENABLED) return '设置 HUB_TEST_BWRAP_QUOTA=1 才运行 bwrap 配额测试';
  if (process.platform !== 'linux') return '仅 Linux bwrap';
  if (!existsSync(BWRAP)) return '未安装 bwrap';
  return false;
}

interface Repos {
  readonly origin: string;
  readonly tipSha: string;
  readonly bundlePath: string;
  readonly ref: string;
}

/** 普通 Git 仓库 + 8 MiB 不可压缩 blob；不构造恶意 pack。 */
async function buildRepos(base: string): Promise<Repos> {
  const seed = join(base, 'seed');
  await mkdir(seed);
  git(seed, ['init', '-q', '-b', 'main']);
  await writeFile(join(seed, 'README.md'), 'baseline\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-qm', 'initial']);

  const origin = join(base, 'origin.git');
  git(base, ['clone', '--bare', '--quiet', seed, origin]);

  const source = join(base, 'source');
  git(base, ['clone', '--quiet', origin, source]);
  git(source, ['checkout', '-q', '-b', 'feature']);
  // 随机内容不可压缩，确保对象写入量超过 2 MiB 配额。
  await writeFile(join(source, 'large.bin'), randomBytes(8 * 1024 * 1024));
  git(source, ['add', '.']);
  git(source, ['commit', '-qm', 'large feature']);
  const tipSha = git(source, ['rev-parse', 'HEAD']).trim();

  const bundlePath = join(base, 'feature.bundle');
  git(source, ['bundle', 'create', '--quiet', bundlePath, 'refs/heads/feature']);
  return { origin, tipSha, bundlePath, ref: `refs/agent-hub/fetch/project-1/${tipSha}` };
}

function importScript(options: {
  readonly target: string;
  readonly origin: string;
  readonly bundlePath: string;
  readonly scratchRoot: string;
  readonly tipSha: string;
  readonly ref: string;
}): string {
  return `
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProjectGitBundleImporter } from ${JSON.stringify(MODULE)};

const target = ${JSON.stringify(options.target)};
const origin = ${JSON.stringify(options.origin)};
const bundlePath = ${JSON.stringify(options.bundlePath)};
const scratchRoot = ${JSON.stringify(options.scratchRoot)};
const tipSha = ${JSON.stringify(options.tipSha)};
const ref = ${JSON.stringify(options.ref)};

function git(args) {
  return execFileSync('git', args, {
    cwd: target,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}
function branch() {
  try { return git(['symbolic-ref', '-q', 'HEAD']).trim(); } catch { return ''; }
}
async function indexStat() {
  const info = await stat(join(target, '.git', 'index'));
  return [info.ino, info.size, info.mtimeMs, info.ctimeMs];
}

await writeFile(join(target, 'local-untracked.txt'), 'keep me\\n');
const statusBefore = git(['status', '--porcelain=v1']);
const before = {
  head: git(['rev-parse', 'HEAD']).trim(),
  branch: branch(),
  index: await indexStat(),
  readme: await readFile(join(target, 'README.md'), 'utf8'),
  local: await readFile(join(target, 'local-untracked.txt'), 'utf8')
};

// scratchRoot 必须在 import 前存在；目标/临时目录两种模式都由调用方创建。
await mkdir(scratchRoot, { recursive: true });
const bytes = await readFile(bundlePath);
const importer = createProjectGitBundleImporter(
  async (path) => path === target ? null : '目录不在允许范围',
  { allowLocalOrigin: true, scratchRoot }
);
const result = await importer.importBundle({
  path: target,
  expectedUrl: origin,
  bundleBase64: bytes.toString('base64'),
  bundleSha256: createHash('sha256').update(bytes).digest('hex'),
  tipSha,
  ref
});

const indexAfter = await indexStat();
let objectPresent = true;
try { git(['cat-file', '-e', tipSha]); } catch { objectPresent = false; }
let refSha = '';
try {
  refSha = git(['for-each-ref', '--format=%(objectname)', ref]).trim();
} catch {}
const after = {
  head: git(['rev-parse', 'HEAD']).trim(),
  branch: branch(),
  status: git(['status', '--porcelain=v1']),
  readme: await readFile(join(target, 'README.md'), 'utf8'),
  local: await readFile(join(target, 'local-untracked.txt'), 'utf8')
};

console.log('RESULT:' + JSON.stringify({
  ok: result.ok,
  code: result.ok ? null : result.error.code,
  message: result.ok ? null : result.error.message,
  refSha,
  objectPresent,
  headSame: before.head === after.head,
  branchSame: before.branch === after.branch,
  indexSame: before.index.every((value, i) => value === indexAfter[i]),
  statusSame: statusBefore === after.status,
  readmeSame: before.readme === after.readme,
  localSame: before.local === after.local
}));
`;
}

function runBwrap(base: string, quotaDir: string, shell: string): string {
  const args = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--bind', base, base,
    '--size', String(2 * 1024 * 1024),
    '--tmpfs', quotaDir,
    '--chdir', base,
    '/bin/sh', '-c', shell
  ];
  return execFileSync(BWRAP, args, {
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function assertQuotaResult(output: string): void {
  const line = output.split('\n').find((entry) => entry.startsWith('RESULT:'));
  assert.ok(line, `未找到结果行：${output}`);
  const result = JSON.parse(line.slice('RESULT:'.length)) as Record<string, unknown>;
  assert.equal(result.ok, false, `不应成功：${JSON.stringify(result)}`);
  assert.equal(result.code, 'unavailable', `失败分类必须未知/环境类：${JSON.stringify(result)}`);
  assert.equal(result.refSha, '');
  assert.equal(result.objectPresent, false);
  assert.equal(result.headSame, true);
  assert.equal(result.branchSame, true);
  assert.equal(result.indexSame, true);
  assert.equal(result.statusSame, true);
  assert.equal(result.readmeSame, true);
  assert.equal(result.localSame, true);
}

/**
 * 只针对本机测试：用 bwrap 的 --tmpfs --size 造一个 2 MiB 盘。
 * 生成的是普通 Git bundle / 普通大文件，不构造恶意 pack。
 */
describe('project git bundle import storage exhaustion (bwrap)', () => {
  it(
    '目标仓库空间耗尽时返回 unknown/unavailable，且不建 ref、不改 HEAD/index/worktree',
    { skip: skipReason() },
    async () => {
      const base = await realpath(await mkdtemp(join('/tmp/opencode', 'agent-hub-bwrap-')));
      try {
        const repos = await buildRepos(base);
        const scratchRoot = join(base, 'scratch');
        await mkdir(scratchRoot);
        const quotaDir = join(base, 'quota');
        await mkdir(quotaDir);
        const target = join(quotaDir, 'target');
        const scriptPath = join(base, 'run-import.mjs');
        await writeFile(
          scriptPath,
          importScript({ target, origin: repos.origin, bundlePath: repos.bundlePath, scratchRoot, tipSha: repos.tipSha, ref: repos.ref })
        );

        const shell = [
          'GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null',
          `git clone --quiet ${quote(repos.origin)} ${quote(target)}`,
          `&& node ${quote(scriptPath)}`
        ].join(' ');
        assertQuotaResult(runBwrap(base, quotaDir, shell));
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    }
  );

  it(
    '临时校验空间耗尽时返回 unknown/unavailable，且目标仓库没有新 ref 或对象',
    { skip: skipReason() },
    async () => {
      const base = await realpath(await mkdtemp(join('/tmp/opencode', 'agent-hub-bwrap-')));
      try {
        const repos = await buildRepos(base);
        const target = join(base, 'target');
        git(base, ['clone', '--quiet', repos.origin, target]);
        const quotaDir = join(base, 'quota');
        await mkdir(quotaDir);
        const scratchRoot = join(quotaDir, 'scratch');
        const scriptPath = join(base, 'run-import.mjs');
        await writeFile(
          scriptPath,
          importScript({ target, origin: repos.origin, bundlePath: repos.bundlePath, scratchRoot, tipSha: repos.tipSha, ref: repos.ref })
        );

        const shell = `node ${quote(scriptPath)}`;
        assertQuotaResult(runBwrap(base, quotaDir, shell));
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    }
  );
});
