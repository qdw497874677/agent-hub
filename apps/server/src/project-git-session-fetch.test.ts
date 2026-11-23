import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asProjectId,
  asSessionId,
  err,
  forbidden,
  notImplemented,
  ok,
  unavailable,
  type DomainError,
  type OperationCompleteInput,
  type OperationCompleteOutcome,
  type OperationReceiptPayload,
  type OperationReceiptStore,
  type OperationReleaseInput,
  type OperationReleaseOutcome,
  type OperationReserveIntent,
  type OperationReserveOutcome,
  type Result
} from '@agent-hub/domain';
import type { ProjectGitFetchOutcome, ProjectGitFetchRequest } from './project-git-fetch.ts';
import {
  PROJECT_GIT_SESSION_FETCH_MAX_BUNDLE_BYTES,
  PROJECT_GIT_SESSION_FETCH_OPERATION,
  fetchProjectGitForSession,
  projectGitSessionFetchRef,
  type ProjectGitSessionBundleImport,
  type ProjectGitSessionFetchAuthorizeInput,
  type ProjectGitSessionFetchBinding,
  type ProjectGitSessionFetchCommand,
  type ProjectGitSessionFetchCredentialInput,
  type ProjectGitSessionFetchDeps,
  type ProjectGitSessionImportOutcome
} from './project-git-session-fetch.ts';

const ACTOR_ID = 'u-owner';
const SESSION_ID = asSessionId('ses-project-fetch');
const PROJECT_ID = asProjectId('proj_test');
const REPO_ID = 'repo-1';
const REPO_URL = 'https://github.com/acme/app.git';
const WORKER_ID = 'worker-1';
const WORKSPACE_ID = 'ws-1';
const WORKSPACE_PATH = '/srv/agent-hub/work/app';
const REQUEST_KEY = 'req-fetch-1';
const TIP = 'a'.repeat(40);

const BUNDLE = Buffer.from('PACK bundle fixture for isolated fetch\n');

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const BINDING: ProjectGitSessionFetchBinding = {
  accountId: ACTOR_ID,
  sessionId: SESSION_ID,
  projectId: PROJECT_ID,
  repoId: REPO_ID,
  repoUrl: REPO_URL,
  workerId: WORKER_ID,
  workspaceId: WORKSPACE_ID,
  workspacePath: WORKSPACE_PATH,
  branch: 'main'
};

const command = (overrides: Partial<ProjectGitSessionFetchCommand> = {}): ProjectGitSessionFetchCommand => ({
  actorId: ACTOR_ID,
  actorVia: 'web',
  sessionId: SESSION_ID,
  requestKey: REQUEST_KEY,
  repoId: REPO_ID,
  ...overrides
});

interface ReceiptRow {
  readonly fingerprint: string;
  readonly reservationId: string;
  status: 'pending' | 'completed';
  payload?: OperationReceiptPayload;
}

function fakeReceipts(): OperationReceiptStore & { calls: string[]; rows: Map<string, ReceiptRow> } {
  const rows = new Map<string, ReceiptRow>();
  const calls: string[] = [];
  let counter = 0;
  return {
    calls,
    rows,
    async reserve(intent: OperationReserveIntent): Promise<OperationReserveOutcome> {
      calls.push('reserve');
      const row = rows.get(intent.key);
      if (!row) {
        const reservationId = `res-${++counter}`;
        rows.set(intent.key, { fingerprint: intent.fingerprint, reservationId, status: 'pending' });
        return { status: 'reserved', reservationId };
      }
      if (row.fingerprint !== intent.fingerprint) return { status: 'conflict' };
      if (row.status === 'pending') return { status: 'pending' };
      return { status: 'completed', payload: row.payload ?? {} };
    },
    async complete(input: OperationCompleteInput): Promise<OperationCompleteOutcome> {
      calls.push('complete');
      const row = rows.get(input.key);
      if (
        !row ||
        row.fingerprint !== input.fingerprint ||
        row.reservationId !== input.reservationId ||
        row.status !== 'pending'
      ) {
        return { status: 'conflict' };
      }
      row.status = 'completed';
      row.payload = input.payload;
      return { status: 'completed' };
    },
    async release(input: OperationReleaseInput): Promise<OperationReleaseOutcome> {
      calls.push('release');
      const row = rows.get(input.key);
      if (
        !row ||
        row.fingerprint !== input.fingerprint ||
        row.reservationId !== input.reservationId ||
        row.status !== 'pending'
      ) {
        return { status: 'conflict' };
      }
      rows.delete(input.key);
      return { status: 'released' };
    }
  };
}

type AuthorizeHandler = (
  input: ProjectGitSessionFetchAuthorizeInput,
  call: number
) => Promise<Result<ProjectGitSessionFetchBinding, DomainError>>;

type FetchHandler = (input: ProjectGitFetchRequest) => Promise<ProjectGitFetchOutcome>;

type ImportHandler = (
  workerId: string,
  input: ProjectGitSessionBundleImport
) => Promise<Result<ProjectGitSessionImportOutcome, DomainError>>;

interface HarnessOptions {
  readonly enabled?: boolean;
  readonly authorize?: AuthorizeHandler;
  readonly fetch?: FetchHandler;
  readonly import?: ImportHandler;
  readonly credential?: (input: ProjectGitSessionFetchCredentialInput) => Promise<string | null>;
  readonly receipts?: ReturnType<typeof fakeReceipts>;
}

function harness(dir: string, options: HarnessOptions = {}) {
  const authorizeCalls: ProjectGitSessionFetchAuthorizeInput[] = [];
  const fetcherCalls: ProjectGitFetchRequest[] = [];
  const importCalls: Array<{ workerId: string; input: ProjectGitSessionBundleImport }> = [];
  const credentialCalls: ProjectGitSessionFetchCredentialInput[] = [];
  const receipts = options.receipts ?? fakeReceipts();

  const authorize: AuthorizeHandler = async (input, call) => {
    authorizeCalls.push(input);
    if (options.authorize) return options.authorize(input, call);
    return ok({ ...BINDING, branch: input.branch ?? BINDING.branch });
  };

  const fetch: FetchHandler = async (input) => {
    fetcherCalls.push(input);
    if (options.fetch) return options.fetch(input);
    const bundlePath = join(dir, `git-fetch-${'a'.repeat(24)}.bundle`);
    await writeFile(bundlePath, BUNDLE);
    return {
      ok: true,
      result: {
        branch: input.branch,
        ref: `refs/heads/${input.branch}`,
        tip: TIP,
        bundlePath,
        bundleBytes: BUNDLE.byteLength,
        bundleSha256: sha256(BUNDLE)
      }
    };
  };

  const importBundle: ImportHandler = async (workerId, input) => {
    importCalls.push({ workerId, input });
    if (options.import) return options.import(workerId, input);
    return ok({ ref: input.ref, tipSha: input.tipSha, alreadyPresent: false });
  };

  const credential = async (input: ProjectGitSessionFetchCredentialInput): Promise<string | null> => {
    credentialCalls.push(input);
    if (options.credential) return options.credential(input);
    return `Basic ${Buffer.from('hub:secret').toString('base64')}`;
  };

  const deps: ProjectGitSessionFetchDeps = {
    policy: { enabled: options.enabled ?? true },
    authorize: (input) => authorize(input, authorizeCalls.length + 1),
    credential,
    fetcher: { fetch },
    importer: importBundle,
    operationReceipts: receipts
  };

  return { deps, authorizeCalls, fetcherCalls, importCalls, credentialCalls, receipts };
}

async function workspace(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-hub-git-session-fetch-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const bundleGone = async (dir: string): Promise<boolean> => {
  try {
    await stat(join(dir, `git-fetch-${'a'.repeat(24)}.bundle`));
    return false;
  } catch {
    return true;
  }
};

test('抓取成功后只把无凭据 bundle 交给绑定 Worker，并落回执', async (t) => {
  const dir = await workspace(t);
  const h = harness(dir);
  const result = await fetchProjectGitForSession(h.deps, command());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    projectId: PROJECT_ID,
    repoId: REPO_ID,
    workerId: WORKER_ID,
    branch: 'main',
    ref: `refs/agent-hub/fetch/${PROJECT_ID}/${TIP}`,
    tip: TIP,
    bundleBytes: BUNDLE.byteLength,
    alreadyPresent: false
  });

  assert.equal(h.authorizeCalls.length, 2);
  assert.deepEqual(h.fetcherCalls, [
    {
      repoUrl: REPO_URL,
      branch: 'main',
      authorization: `Basic ${Buffer.from('hub:secret').toString('base64')}`
    }
  ]);
  assert.equal(h.importCalls.length, 1);
  const imported = h.importCalls[0]!;
  assert.equal(imported.workerId, WORKER_ID);
  assert.equal(imported.input.path, WORKSPACE_PATH);
  assert.equal(imported.input.expectedUrl, REPO_URL);
  assert.equal(imported.input.tipSha, TIP);
  assert.equal(imported.input.ref, `refs/agent-hub/fetch/${PROJECT_ID}/${TIP}`);
  assert.equal(imported.input.bundleSha256, sha256(BUNDLE));
  assert.deepEqual(Buffer.from(imported.input.bundleBase64, 'base64'), BUNDLE);
  assert.deepEqual(h.receipts.calls, ['reserve', 'complete']);
  const stored = [...h.receipts.rows.values()][0]!.payload!;
  assert.equal(typeof stored.bindingHash, 'string');
  assert.equal(JSON.stringify(stored).includes(WORKSPACE_PATH), false, '回执不落原始工作空间路径');
  assert.equal(JSON.stringify(stored).includes(REPO_URL), false, '回执不落原始仓库地址');
  assert.equal(await bundleGone(dir), true, 'bundle 文件应在导入后清理');
});

test('默认分支由授权缝填；显式分支必须原样进入抓取与导入', async (t) => {
  const dir = await workspace(t);
  const h = harness(dir);
  const result = await fetchProjectGitForSession(h.deps, command({ branch: 'release/1.0' }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.branch, 'release/1.0');
  assert.equal(h.fetcherCalls[0]!.branch, 'release/1.0');
  assert.deepEqual(h.authorizeCalls.map((call) => call.branch), ['release/1.0', 'release/1.0']);
});

test('授权拒绝：不占回执、不抓取、不调用 Worker', async (t) => {
  const dir = await workspace(t);
  const h = harness(dir, {
    authorize: async () => err(forbidden('项目授权与会话当前绑定不一致'))
  });
  const result = await fetchProjectGitForSession(h.deps, command());

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'forbidden');
  assert.deepEqual(h.receipts.calls, []);
  assert.deepEqual(h.fetcherCalls, []);
  assert.deepEqual(h.importCalls, []);
  assert.deepEqual(h.credentialCalls, []);
});

test('部署未启用：直接拒绝，绝不回落到带凭据路径', async (t) => {
  const dir = await workspace(t);
  const h = harness(dir, { enabled: false });
  const result = await fetchProjectGitForSession(h.deps, command());

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'unavailable');
  assert.match(result.error.message, /未在当前部署启用/);
  assert.deepEqual(h.authorizeCalls, []);
  assert.deepEqual(h.receipts.calls, []);
  assert.deepEqual(h.fetcherCalls, []);
  assert.deepEqual(h.importCalls, []);
});

test('同一请求键重试：返回原结果，不重复抓取或导入', async (t) => {
  const dir = await workspace(t);
  const h = harness(dir);
  const first = await fetchProjectGitForSession(h.deps, command());
  const second = await fetchProjectGitForSession(h.deps, command());

  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(h.fetcherCalls.length, 1);
  assert.equal(h.importCalls.length, 1);
  assert.deepEqual(h.receipts.calls, ['reserve', 'complete', 'reserve']);
});

test('同一请求键不同参数：冲突，不抓取、不覆盖原回执', async (t) => {
  const dir = await workspace(t);
  const h = harness(dir);
  const first = await fetchProjectGitForSession(h.deps, command());
  assert.equal(first.ok, true);

  const conflicting = await fetchProjectGitForSession(h.deps, command({ branch: 'dev' }));
  assert.equal(conflicting.ok, false);
  if (conflicting.ok) return;
  assert.equal(conflicting.error.code, 'conflict');
  assert.equal(h.fetcherCalls.length, 1);
  assert.equal(h.importCalls.length, 1);
  assert.deepEqual(h.receipts.calls, ['reserve', 'complete', 'reserve']);
});

test('凭据只进抓取缝，导入参数里没有凭据字段', async (t) => {
  const dir = await workspace(t);
  const authorization = `Basic ${Buffer.from('hub:top-secret-token').toString('base64')}`;
  const h = harness(dir, { credential: async () => authorization });
  const result = await fetchProjectGitForSession(h.deps, command());
  assert.equal(result.ok, true);

  assert.equal(h.fetcherCalls[0]!.authorization, authorization);
  const sent = h.importCalls[0]!.input;
  assert.deepEqual(Object.keys(sent).sort(), [
    'bundleBase64',
    'bundleSha256',
    'expectedUrl',
    'path',
    'ref',
    'tipSha'
  ]);
  const wire = JSON.stringify(sent);
  assert.equal(wire.includes(authorization), false);
  assert.equal(wire.includes('top-secret-token'), false);
  assert.equal(wire.includes('authorization'), false);
});

test('凭据不可用：确定没有副作用，释放占位后可重试', async (t) => {
  const dir = await workspace(t);
  const h = harness(dir, { credential: async () => null });
  const result = await fetchProjectGitForSession(h.deps, command());

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'unavailable');
  assert.deepEqual(h.receipts.calls, ['reserve', 'release']);
  assert.deepEqual(h.fetcherCalls, []);
  assert.deepEqual(h.importCalls, []);
});

test('抓取后绑定漂移：不导入，释放占位', async (t) => {
  const dir = await workspace(t);
  const h = harness(dir, {
    authorize: async (input, call) => {
      if (call <= 1) return ok({ ...BINDING, branch: input.branch ?? BINDING.branch });
      return ok({ ...BINDING, branch: input.branch ?? BINDING.branch, workerId: 'worker-2' });
    }
  });
  const result = await fetchProjectGitForSession(h.deps, command());

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'forbidden');
  assert.match(result.error.message, /确认前发生变化/);
  assert.equal(h.fetcherCalls.length, 1);
  assert.deepEqual(h.importCalls, []);
  assert.deepEqual(h.receipts.calls, ['reserve', 'release']);
});

test('bundle 超过 8 MiB 或摘要不符：拒绝导入并清理文件', async (t) => {
  const dir = await workspace(t);

  const oversize = harness(dir, {
    fetch: async (input) => {
      const bundlePath = join(dir, `git-fetch-${'a'.repeat(24)}.bundle`);
      await writeFile(bundlePath, BUNDLE);
      return {
        ok: true,
        result: {
          branch: input.branch,
          ref: `refs/heads/${input.branch}`,
          tip: TIP,
          bundlePath,
          bundleBytes: PROJECT_GIT_SESSION_FETCH_MAX_BUNDLE_BYTES + 1,
          bundleSha256: sha256(BUNDLE)
        }
      };
    }
  });
  const tooLarge = await fetchProjectGitForSession(oversize.deps, command());
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) assert.match(tooLarge.error.message, /8 MiB/);
  assert.deepEqual(oversize.importCalls, []);
  assert.deepEqual(oversize.receipts.calls, ['reserve', 'release']);
  assert.equal(await bundleGone(dir), true);

  const tampered = harness(dir, {
    fetch: async (input) => {
      const bundlePath = join(dir, `git-fetch-${'a'.repeat(24)}.bundle`);
      await writeFile(bundlePath, BUNDLE);
      return {
        ok: true,
        result: {
          branch: input.branch,
          ref: `refs/heads/${input.branch}`,
          tip: TIP,
          bundlePath,
          bundleBytes: BUNDLE.byteLength,
          bundleSha256: sha256(Buffer.from('different'))
        }
      };
    }
  });
  const mismatch = await fetchProjectGitForSession(tampered.deps, command());
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.code, 'unavailable');
  assert.deepEqual(tampered.importCalls, []);
  assert.deepEqual(tampered.receipts.calls, ['reserve', 'release']);
  assert.equal(await bundleGone(dir), true);
});

test('Worker 未启用导入：确定没有副作用，释放占位', async (t) => {
  const dir = await workspace(t);
  const h = harness(dir, {
    import: async () => err(notImplemented('project git bundle import'))
  });
  const result = await fetchProjectGitForSession(h.deps, command());

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'unavailable');
  assert.match(result.error.message, /未启用/);
  assert.deepEqual(h.receipts.calls, ['reserve', 'release']);
  assert.equal(h.importCalls.length, 1);
});

test('导入结果不一致或不明：保留 pending，不回传原始错误、不自动重放', async (t) => {
  const dir = await workspace(t);

  const mismatched = harness(dir, {
    import: async (_workerId, input) =>
      ok({ ref: input.ref, tipSha: 'b'.repeat(40), alreadyPresent: false })
  });
  const changed = await fetchProjectGitForSession(mismatched.deps, command());
  assert.equal(changed.ok, false);
  if (!changed.ok) {
    assert.match(changed.error.message, /结果尚未确认/);
    assert.match(changed.error.message, /只读核对回执/);
    assert.match(changed.error.message, /不要自动重放/);
  }
  assert.deepEqual(mismatched.receipts.calls, ['reserve']);

  const lost = harness(dir, {
    import: async () => err(unavailable('worker raw failure with /srv/secret/path'))
  });
  const unknown = await fetchProjectGitForSession(lost.deps, command());
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.match(unknown.error.message, /结果尚未确认/);
    assert.match(unknown.error.message, /只读核对回执/);
    assert.equal(unknown.error.message.includes('/srv/secret/path'), false);
  }
  assert.deepEqual(lost.receipts.calls, ['reserve']);

  // pending 保留后，同键再来只做只读核查，不重新抓取或导入。
  const retry = await fetchProjectGitForSession(lost.deps, command());
  assert.equal(retry.ok, false);
  if (!retry.ok) {
    assert.equal(retry.error.code, 'conflict');
    assert.match(retry.error.message, /只读核对回执/);
    assert.match(retry.error.message, /不要重复执行/);
  }
  assert.equal(lost.fetcherCalls.length, 1);
  assert.equal(lost.importCalls.length, 1);
});

test('专用 ref 只接受安全项目 id 与完整小写 SHA', () => {
  assert.equal(projectGitSessionFetchRef('proj_1', TIP).ok, true);
  assert.equal(projectGitSessionFetchRef('../evil', TIP).ok, false);
  assert.equal(projectGitSessionFetchRef('proj_1', 'A'.repeat(40)).ok, false);
  assert.equal(projectGitSessionFetchRef('proj_1', 'a'.repeat(64)).ok, false);
});

test('操作名固定，避免与其他写操作共享回执键空间', () => {
  assert.equal(PROJECT_GIT_SESSION_FETCH_OPERATION, 'project.git.session-fetch');
});

test('同键在绑定漂移后重放：目标摘要进指纹，直接冲突且不抓取、不导入', async (t) => {
  const dir = await workspace(t);
  const receipts = fakeReceipts();
  const first = harness(dir, { receipts });
  const result = await fetchProjectGitForSession(first.deps, command());
  assert.equal(result.ok, true);

  // 会话换到别的 Worker 后用同一请求键重放。
  const moved = harness(dir, { receipts, authorize: async () => ok({ ...BINDING, workerId: 'worker-2' }) });
  const replay = await fetchProjectGitForSession(moved.deps, command());
  assert.equal(replay.ok, false);
  if (replay.ok) return;
  assert.equal(replay.error.code, 'conflict');
  assert.match(replay.error.message, /不同参数/);
  assert.equal(moved.fetcherCalls.length, 0);
  assert.equal(moved.importCalls.length, 0);
});

test('抓取后工作空间路径精确值变化（仅多一个斜杠）也算漂移', async (t) => {
  const dir = await workspace(t);
  const h = harness(dir, {
    authorize: async (input, call) => {
      const base = { ...BINDING, branch: input.branch ?? BINDING.branch };
      return ok(call <= 1 ? base : { ...base, workspacePath: `${WORKSPACE_PATH}/` });
    }
  });
  const result = await fetchProjectGitForSession(h.deps, command());

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'forbidden');
  assert.match(result.error.message, /确认前发生变化/);
  assert.deepEqual(h.importCalls, []);
  assert.deepEqual(h.receipts.calls, ['reserve', 'release']);
});

test('授权缝抛异常：第一次中性拒绝且零副作用，第二次释放占位', async (t) => {
  const dir = await workspace(t);
  const firstThrow = harness(dir, {
    authorize: async () => {
      throw new Error('vault /srv/secret exploded');
    }
  });
  const first = await fetchProjectGitForSession(firstThrow.deps, command());
  assert.equal(first.ok, false);
  if (!first.ok) {
    assert.equal(first.error.code, 'unavailable');
    assert.match(first.error.message, /授权暂时不可用/);
    assert.equal(first.error.message.includes('/srv/secret'), false);
  }
  assert.deepEqual(firstThrow.receipts.calls, []);
  assert.deepEqual(firstThrow.fetcherCalls, []);
  assert.deepEqual(firstThrow.importCalls, []);

  const secondThrow = harness(dir, {
    authorize: async (input, call) => {
      if (call <= 1) return ok({ ...BINDING, branch: input.branch ?? BINDING.branch });
      throw new Error('vault /srv/secret exploded');
    }
  });
  const second = await fetchProjectGitForSession(secondThrow.deps, command());
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.error.code, 'unavailable');
    assert.match(second.error.message, /授权暂时不可用/);
    assert.equal(second.error.message.includes('/srv/secret'), false);
  }
  assert.equal(secondThrow.fetcherCalls.length, 1);
  assert.deepEqual(secondThrow.importCalls, []);
  assert.deepEqual(secondThrow.receipts.calls, ['reserve', 'release']);
});

test('bundle 路径是符号链接：不跟随，释放占位且不导入', async (t) => {
  const dir = await workspace(t);
  const target = join(dir, 'outside.bundle');
  await writeFile(target, BUNDLE);
  const link = join(dir, `git-fetch-${'a'.repeat(24)}.bundle`);
  await symlink(target, link);

  const h = harness(dir, {
    fetch: async (input) => ({
      ok: true,
      result: {
        branch: input.branch,
        ref: `refs/heads/${input.branch}`,
        tip: TIP,
        bundlePath: link,
        bundleBytes: BUNDLE.byteLength,
        bundleSha256: sha256(BUNDLE)
      }
    })
  });
  const result = await fetchProjectGitForSession(h.deps, command());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /不存在或不可读取/);
  assert.deepEqual(h.importCalls, []);
  assert.deepEqual(h.receipts.calls, ['reserve', 'release']);
  assert.equal(await bundleGone(dir), true, '符号链接本身应被清理');
});

test('bundle 在抓取后多出字节：长度不一致即拒绝，不读入多余内容', async (t) => {
  const dir = await workspace(t);
  const h = harness(dir, {
    fetch: async (input) => {
      const bundlePath = join(dir, `git-fetch-${'a'.repeat(24)}.bundle`);
      await writeFile(bundlePath, Buffer.concat([BUNDLE, Buffer.from('X')]));
      return {
        ok: true,
        result: {
          branch: input.branch,
          ref: `refs/heads/${input.branch}`,
          tip: TIP,
          bundlePath,
          bundleBytes: BUNDLE.byteLength,
          bundleSha256: sha256(BUNDLE)
        }
      };
    }
  });
  const result = await fetchProjectGitForSession(h.deps, command());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /大小与抓取结果不一致/);
  assert.deepEqual(h.importCalls, []);
  assert.deepEqual(h.receipts.calls, ['reserve', 'release']);
  assert.equal(await bundleGone(dir), true);
});

test('读取 bundle 失败（文件缺失）：释放占位，不导入', async (t) => {
  const dir = await workspace(t);
  const h = harness(dir, {
    fetch: async (input) => ({
      ok: true,
      result: {
        branch: input.branch,
        ref: `refs/heads/${input.branch}`,
        tip: TIP,
        bundlePath: join(dir, 'missing.bundle'),
        bundleBytes: BUNDLE.byteLength,
        bundleSha256: sha256(BUNDLE)
      }
    })
  });
  const result = await fetchProjectGitForSession(h.deps, command());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /不存在/);
  assert.deepEqual(h.receipts.calls, ['reserve', 'release']);
  assert.deepEqual(h.importCalls, []);
});
