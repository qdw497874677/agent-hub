import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  asLoginId,
  asProjectId,
  asSessionId,
  asTeamId,
  asUserId,
  ok,
  type Asset,
  type AssetRevision,
  type AuditEntry,
  type DomainError,
  type OperationReceiptPayload,
  type OperationReceiptStore,
  type OperationReserveOutcome,
  type Principal,
  type Project,
  type ProjectSessionGrant,
  type ProjectSessionGrantScope,
  type Result,
  type Session,
  type User
} from '@agent-hub/domain';
import { inMemoryAdmin, inMemoryAssetReviewDeps, inMemoryAssets, inMemoryDeps } from '@agent-hub/domain/testing';
import { createProjectSessionAssetActions } from './project-session-assets.ts';
import type { ProjectAssetBinding, ProjectAssetInputFile } from './project-session-asset-tools.ts';

const OWNER = 'u-owner';
const MEMBER = 'u-member';
const TEAM = 't1';
const PROJECT = 'p1';
const SESSION = 's1';
const VIA = 'tool' as const;

const binding: ProjectAssetBinding = {
  actorId: OWNER,
  actorVia: VIA,
  sessionId: asSessionId(SESSION)
};

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function userOf(id: string, role: User['role'], clusterAdmin = false): User {
  return {
    id: asUserId(id),
    email: `${id}@example.com`,
    displayName: id,
    role,
    passwordHash: null,
    emailVerifiedAt: 1,
    disabledAt: null,
    createdAt: 1,
    teamId: asTeamId(TEAM),
    clusterAdmin,
    deletedAt: null
  };
}

function principalOf(id: string): Principal {
  return { user: userOf(id, id === OWNER ? 'owner' : 'member'), loginId: asLoginId(id) };
}

function projectRow(): Project {
  return {
    id: asProjectId(PROJECT),
    name: 'demo',
    repo: null,
    repos: [],
    description: null,
    createdAt: 1,
    teamId: asTeamId(TEAM),
    createdBy: OWNER,
    members: [],
    worktree: null,
    checks: [],
    assetSetIds: [],
    deletedAt: null
  };
}

function grantOf(scopes: readonly ProjectSessionGrantScope[], accountId = OWNER): ProjectSessionGrant {
  return {
    id: 'g1',
    accountId,
    sessionId: asSessionId(SESSION),
    projectId: asProjectId(PROJECT),
    scopes,
    createdBy: accountId,
    createdAt: 1,
    expiresAt: null,
    revokedAt: null,
    revokedBy: null
  };
}

interface ReceiptRow {
  fingerprint: string;
  state: 'reserved' | 'completed';
  payload?: OperationReceiptPayload;
}

function fakeReceipts(): OperationReceiptStore & { payloads: OperationReceiptPayload[] } {
  const rows = new Map<string, ReceiptRow>();
  const payloads: OperationReceiptPayload[] = [];
  let counter = 0;
  return {
    payloads,
    async reserve(input): Promise<OperationReserveOutcome> {
      const row = rows.get(input.key);
      if (!row) {
        counter += 1;
        rows.set(input.key, { fingerprint: input.fingerprint, state: 'reserved' });
        return { status: 'reserved', reservationId: `r${counter}` };
      }
      if (row.fingerprint !== input.fingerprint) return { status: 'conflict' };
      if (row.state === 'completed' && row.payload !== undefined) return { status: 'completed', payload: row.payload };
      return { status: 'pending' };
    },
    async complete(input) {
      const row = rows.get(input.key);
      if (!row || row.state !== 'reserved' || row.fingerprint !== input.fingerprint) return { status: 'conflict' };
      row.state = 'completed';
      row.payload = input.payload;
      payloads.push(input.payload);
      return { status: 'completed' };
    },
    async release(input) {
      const row = rows.get(input.key);
      if (!row || row.state !== 'reserved' || row.fingerprint !== input.fingerprint) return { status: 'conflict' };
      rows.delete(input.key);
      return { status: 'released' };
    }
  };
}

async function harness(options: {
  readonly scopes?: readonly ProjectSessionGrantScope[];
  readonly grantAccountId?: string;
  readonly rejectActor?: string;
} = {}) {
  const admin = inMemoryAdmin();
  const world = inMemoryDeps();
  const assets = inMemoryAssets();
  const review = inMemoryAssetReviewDeps(admin, assets);
  await admin.accounts.users.save(userOf(OWNER, 'owner'));
  await admin.accounts.users.save(userOf(MEMBER, 'member'));
  await world.deps.projects.save(projectRow());
  const scopes = options.scopes ?? ['project:read', 'asset:write'];
  const grants = {
    authorize: async (): Promise<Result<ProjectSessionGrant, DomainError>> =>
      ok(grantOf(scopes, options.grantAccountId ?? OWNER))
  };
  const session = { id: asSessionId(SESSION) } as unknown as Session;
  const receipts = fakeReceipts();
  const actions = createProjectSessionAssetActions({
    grants,
    assets: { ...review.deps, projects: world.deps.projects },
    sessions: { byId: async (id) => (id === SESSION ? session : null) },
    operationReceipts: receipts,
    loadActor: async (accountId) => {
      if (accountId === OWNER) return principalOf(OWNER);
      if (accountId === MEMBER) return principalOf(MEMBER);
      return null;
    }
  });
  return { admin, world, assets, review, actions, receipts, assetDeps: { ...review.deps, projects: world.deps.projects } };
}

function failure<T>(result: Result<T, DomainError>): DomainError {
  assert.equal(result.ok, false);
  return (result as { ok: false; error: DomainError }).error;
}

function success<T>(result: Result<T, DomainError>): T {
  assert.equal(result.ok, true);
  return (result as { ok: true; value: T }).value;
}

async function seedAsset(
  assets: Awaited<ReturnType<typeof harness>>['assetDeps'],
  input: {
    readonly id: string;
    readonly kind: 'skill' | 'instruction' | 'mcp';
    readonly name: string;
    readonly scope: 'project' | 'team' | 'global' | 'personal';
    readonly projectId?: string | null;
    readonly teamId?: string | null;
    readonly content: string;
    readonly published: boolean;
    readonly path?: string;
  }
): Promise<{ asset: Asset; digest: string }> {
  const path = input.path ?? 'SKILL.md';
  const text = input.content;
  const digest = sha(`${input.id}:${text}`);
  const files = [{ path, sha256: sha(text), size: Buffer.byteLength(text, 'utf8') }];
  const revision: AssetRevision = {
    assetId: input.id,
    digest,
    name: input.name,
    description: '',
    files,
    commit: null,
    createdAt: 2
  };
  const asset: Asset = {
    id: input.id,
    kind: input.kind,
    name: input.name,
    projectId: input.projectId === undefined ? PROJECT : input.projectId,
    scope: input.scope,
    ownerId: OWNER,
    teamId: input.teamId === undefined ? TEAM : input.teamId,
    description: '',
    source: { type: 'upload' },
    pinned: input.published ? digest : '',
    latest: digest,
    createdAt: 2,
    updatedAt: 2
  };
  await assets.assets.create(asset, revision, new Map([[sha(text), new TextEncoder().encode(text)]]));
  return { asset, digest };
}

function skillFile(content: string, path = 'SKILL.md'): ProjectAssetInputFile {
  return { path, content };
}

test('list 只返回当前项目可用的已发布资产，隐藏停用与被覆盖项', async () => {
  const h = await harness();
  await seedAsset(h.assetDeps, { id: 'a-proj', kind: 'skill', name: 'fmt', scope: 'project', content: 'project', published: true });
  await seedAsset(h.assetDeps, { id: 'a-team', kind: 'skill', name: 'fmt', scope: 'team', content: 'team', published: true });
  await seedAsset(h.assetDeps, { id: 'a-pending', kind: 'skill', name: 'wip', scope: 'project', content: 'wip', published: false });
  await seedAsset(h.assetDeps, { id: 'a-off', kind: 'instruction', name: 'quiet', scope: 'project', content: 'off', published: true });
  await h.assetDeps.assets.setProjectSetting(PROJECT, 'a-off', false);

  const visible = success(await h.actions.listAssets({ ...binding, kind: null, includeDisabled: false, limit: 50 }));
  assert.deepEqual(visible.map((row) => row.assetId), ['a-proj']);
  assert.equal(visible[0]?.overridden, false);
  assert.equal(visible[0]?.shadowedBy, null);

  const withDisabled = success(await h.actions.listAssets({ ...binding, kind: null, includeDisabled: true, limit: 50 }));
  assert.deepEqual(withDisabled.map((row) => row.assetId), ['a-proj', 'a-team', 'a-off']);
  const team = withDisabled.find((row) => row.assetId === 'a-team');
  assert.equal(team?.shadowedBy, 'a-proj');
  assert.equal(team?.enabled, true, 'enabled 反映显式开关；被项目级覆盖由 shadowedBy 表示');
  const off = withDisabled.find((row) => row.assetId === 'a-off');
  assert.equal(off?.enabled, false);
  assert.equal(off?.overridden, true);
});

test('read 只读 pinned 版本，不读待审 latest；缺失或未发布都按不存在处理', async () => {
  const h = await harness();
  const { asset, digest } = await seedAsset(h.assetDeps, {
    id: 'a-read',
    kind: 'skill',
    name: 'reader',
    scope: 'project',
    content: 'pinned body',
    published: true
  });
  const latestText = 'pending body';
  const latestDigest = sha(`${asset.id}:${latestText}`);
  await h.assetDeps.assets.addRevision(
    {
      assetId: asset.id,
      digest: latestDigest,
      name: asset.name,
      description: '',
      files: [{ path: 'SKILL.md', sha256: sha(latestText), size: Buffer.byteLength(latestText, 'utf8') }],
      commit: null,
      createdAt: 3
    },
    new Map([[sha(latestText), new TextEncoder().encode(latestText)]])
  );
  await h.assetDeps.assets.update({ ...asset, latest: latestDigest, updatedAt: 3 });

  const snapshot = success(await h.actions.readAsset({ ...binding, assetId: asset.id, path: null }));
  assert.equal(snapshot.digest, digest);
  assert.equal(snapshot.file, null);
  assert.deepEqual(snapshot.files.map((file) => file.path), ['SKILL.md']);

  const file = success(await h.actions.readAsset({ ...binding, assetId: asset.id, path: 'SKILL.md' }));
  assert.equal(file.file?.content, 'pinned body');
  assert.equal(file.file?.size, Buffer.byteLength('pinned body', 'utf8'));

  assert.equal(failure(await h.actions.readAsset({ ...binding, assetId: asset.id, path: 'missing.md' })).code, 'not_found');

  const hidden = await seedAsset(h.assetDeps, { id: 'a-wip', kind: 'skill', name: 'wip', scope: 'project', content: 'wip', published: false });
  assert.equal(failure(await h.actions.readAsset({ ...binding, assetId: hidden.asset.id, path: null })).code, 'not_found');
});

test('read 拒绝超过 64 KiB 的文本文件，二进制文件也不返回内容', async () => {
  const h = await harness();
  const big = 'x'.repeat(70 * 1024);
  const { asset } = await seedAsset(h.assetDeps, {
    id: 'a-big',
    kind: 'skill',
    name: 'big',
    scope: 'project',
    content: big,
    published: true
  });
  const error = failure(await h.actions.readAsset({ ...binding, assetId: asset.id, path: 'SKILL.md' }));
  assert.equal(error.code, 'invalid');
  assert.match(error.message, /64 KiB/);
});

test('create 走提交审批：回执先落库、重放同键返回同一结果、不同参数同键冲突，且回执不含正文', async () => {
  const h = await harness();
  const command = {
    ...binding,
    requestKey: 'req-create-1',
    kind: 'skill' as const,
    name: 'demo-skill',
    files: [skillFile('---\nname: demo-skill\ndescription: demo\n---\nsecret body')]
  };
  const created = success(await h.actions.createAsset(command));
  assert.equal(created.published, false, '项目级新资产必须等审批，不能直接发布');
  assert.equal(created.assetId.length > 0, true);
  assert.equal(typeof created.submissionId, 'string');
  assert.equal(created.submissionStatus, 'pending');
  assert.equal(h.receipts.payloads.length, 1);
  assert.equal(JSON.stringify(h.receipts.payloads).includes('secret body'), false);

  const replay = success(await h.actions.createAsset(command));
  assert.deepEqual(replay, created);
  assert.equal((await h.assetDeps.assets.list()).length, 1);

  const conflict = failure(
    await h.actions.createAsset({ ...command, files: [skillFile('---\nname: demo-skill\ndescription: demo\n---\nother')] })
  );
  assert.match(conflict.message, /请求键/);
});

test('revise 只能改当前项目的项目级资产，共享/团队原件拒绝', async () => {
  const h = await harness();
  await seedAsset(h.assetDeps, { id: 'a-team', kind: 'skill', name: 'shared', scope: 'team', content: 'team', published: true });
  const error = failure(
    await h.actions.reviseAsset({
      ...binding,
      requestKey: 'req-revise-team',
      assetId: 'a-team',
      files: [skillFile('---\nname: shared\ndescription: shared\n---\nv2')]
    })
  );
  assert.equal(error.code, 'forbidden');
  assert.match(error.message, /只能修订当前项目的项目级资产/);
});

test('revise 项目资产生成新的待审提交，回执记录摘要但不含正文', async () => {
  const h = await harness();
  const seeded = await seedAsset(h.assetDeps, {
    id: 'a-proj',
    kind: 'skill',
    name: 'mine',
    scope: 'project',
    content: 'v1',
    published: true
  });
  const revised = success(
    await h.actions.reviseAsset({
      ...binding,
      requestKey: 'req-revise-1',
      assetId: seeded.asset.id,
      files: [skillFile('---\nname: mine\ndescription: mine\n---\nsecret v2')]
    })
  );
  assert.equal(revised.assetId, seeded.asset.id);
  assert.notEqual(revised.digest, seeded.digest);
  assert.equal(revised.published, false);
  assert.equal(revised.submissionStatus, 'pending');
  assert.equal(JSON.stringify(h.receipts.payloads).includes('secret v2'), false);
});

test('set_enabled 只允许项目创建者或团队管理员，且写审计不含资产正文', async () => {
  const h = await harness();
  const seeded = await seedAsset(h.assetDeps, {
    id: 'a-switch',
    kind: 'skill',
    name: 'switch',
    scope: 'project',
    content: 'body',
    published: true
  });

  const denied = failure(
    await h.actions.setAssetEnabled({ actorId: MEMBER, actorVia: VIA, sessionId: asSessionId(SESSION), requestKey: 'req-enable-member', assetId: seeded.asset.id, enabled: false })
  );
  assert.equal(denied.code, 'forbidden');

  await h.assetDeps.assets.setProjectSetting(PROJECT, seeded.asset.id, false);
  const reset = success(
    await h.actions.setAssetEnabled({ ...binding, requestKey: 'req-enable-owner', assetId: seeded.asset.id, enabled: null })
  );
  assert.equal(reset.enabled, true);
  assert.equal(reset.overridden, false);

  const disabled = success(
    await h.actions.setAssetEnabled({ ...binding, requestKey: 'req-enable-off', assetId: seeded.asset.id, enabled: false })
  );
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.overridden, true);

  const audit = h.admin.entries.find((entry: AuditEntry) => entry.action === 'asset.project');
  assert.ok(audit);
  assert.equal(audit.target, seeded.asset.id);
  assert.equal(audit.detail.includes('body'), false);
});

test('授权身份与调用绑定不一致或缺少写范围时拒绝', async () => {
  const mismatch = await harness({ grantAccountId: MEMBER });
  const error = failure(
    await mismatch.actions.listAssets({ ...binding, kind: null, includeDisabled: false, limit: 20 })
  );
  assert.equal(error.code, 'forbidden');

  const readOnly = await harness({ scopes: ['project:read'] });
  const missing = failure(
    await readOnly.actions.createAsset({
      ...binding,
      requestKey: 'req-no-write',
      kind: 'skill',
      name: 'nope',
      files: [skillFile('---\nname: nope\ndescription: nope\n---\nbody')]
    })
  );
  assert.equal(missing.code, 'forbidden');
});
