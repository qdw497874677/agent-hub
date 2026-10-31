import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateAssetOwnership, packAsset, workerAssetManifest, type Asset, type AssetReviewDeps, type TeamId, type User, type UserId } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';

const enc = (text: string) => new TextEncoder().encode(text);

const admin: User = {
  id: 'u-admin' as UserId, email: 'boss@x.co', displayName: 'boss', role: 'owner', passwordHash: null, emailVerifiedAt: 1,
  disabledAt: null, createdAt: 1, teamId: 't0' as TeamId, hubAdmin: true, deletedAt: null
};

test('审核仓库：提交 / 评论 / 安装申请 / 通知往返；审核人存在通用 access_grants 表里', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-review-'));
  try {
    const path = join(dir, 'hub.db');
    let store = openSqliteStore(path);
    const report = { findings: [], mcp: null, secrets: [], diffFiles: 0 } as never;
    const sub = {
      id: 's1', assetId: 'a1', digest: 'd2', previous: 'd1', submittedBy: 'u1', origin: 'user', tokenId: null, targetScope: null, status: 'pending',
      required: 1, approvals: [], decidedBy: null, reason: null, report, createdAt: 5, decidedAt: null
    } as const;
    await store.assetReview.addSubmission(sub);
    await store.assetReview.updateSubmission({ ...sub, approvals: [{ userId: 'u2', at: 6, selfApproved: false }] });
    await store.assetReview.addComment({ id: 'c1', submissionId: 's1', authorId: 'u2', path: 'SKILL.md', line: 3, body: '？', at: 7 });
    await store.assetReview.addInstallRequest({ id: 'r1', assetId: 'a1', workerId: 'w2', requestedBy: 'u1', status: 'pending', decidedBy: null, reason: null, createdAt: 8, decidedAt: null });
    await store.assetReview.setSettings('t1', { reviewers: ['u2', 'u3'], twoReviewers: { global: false, mcpStdio: true } });
    await store.assetReview.setSettings('t1', { reviewers: ['u3'], twoReviewers: { global: false, mcpStdio: true } });
    await store.notifications.add({ id: 'n1', userId: 'u1', kind: 'review.approved', title: 't', body: 'b', link: '#/assets', at: 9, readAt: null });
    store.close();
    store = openSqliteStore(path);
    assert.equal((await store.assetReview.submission('s1'))?.approvals[0]?.userId, 'u2');
    assert.deepEqual((await store.assetReview.submissions({ status: ['pending'] })).map((s) => s.id), ['s1']);
    assert.equal((await store.assetReview.comments('s1'))[0]?.line, 3);
    assert.equal((await store.assetReview.installRequests({ status: 'pending' })).length, 1);
    assert.deepEqual(await store.assetReview.settings('t1'), { reviewers: ['u3'], twoReviewers: { global: false, mcpStdio: true } });
    assert.equal(await store.assetReview.settings('nope'), null);
    assert.equal(await store.notifications.unread('u1'), 1);
    await store.notifications.markRead('u1', null, 10);
    assert.equal(await store.notifications.unread('u1'), 0);
    store.close();
    const db = new DatabaseSync(path);
    assert.deepEqual(db.prepare('SELECT subject_id, permission, resource_type, resource_id FROM access_grants').all().map((r) => ({ ...r })), [
      { subject_id: 'u3', permission: 'asset.review', resource_type: 'team', resource_id: 't1' }
    ]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('迁移（ADR 0016）：老库的资产 → 全局 / 项目级、记到 hub 管理员名下；数量与 Worker 清单前后一致；幂等', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-review-mig-'));
  try {
    const path = join(dir, 'hub.db');
    let store = openSqliteStore(path);
    const v1 = await packAsset('skill', [{ path: 'SKILL.md', data: enc('one') }]);
    const v2 = await packAsset('skill', [{ path: 'SKILL.md', data: enc('two') }]);
    assert.ok(v1.ok && v2.ok);
    const base = { kind: 'skill', description: 'd', source: { type: 'upload' }, scope: 'global', ownerId: '', teamId: null, createdAt: 1, updatedAt: 1 } as const;
    const g: Asset = { ...base, id: 'g', name: 'greeter', pinned: v1.value.digest, latest: v2.value.digest, projectId: null } as Asset;
    const p: Asset = { ...base, id: 'p', name: 'greeter', pinned: v1.value.digest, latest: v1.value.digest, projectId: 'proj1', scope: 'project' } as Asset;
    const rev = (id: string, packed: typeof v1.value, at: number) => ({ assetId: id, digest: packed.digest, name: 'greeter', description: 'd', files: packed.files, commit: null, createdAt: at });
    await store.assets.create(g, rev('g', v1.value, 1), v1.value.blobs);
    await store.assets.addRevision(rev('g', v2.value, 2), v2.value.blobs);
    await store.assets.create(p, rev('p', v1.value, 1), v1.value.blobs);
    await store.assets.install('w1', 'g', 3);
    await store.assets.install('w1', 'p', 3);
    const before = await workerAssetManifest(store, 'w1');
    store.close();

    // 降回老表结构（master 上的 assets 表），模拟线上老库
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA foreign_keys = OFF;
CREATE TABLE assets_old (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL,
  pinned TEXT NOT NULL, latest TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, project_id TEXT NOT NULL DEFAULT '', UNIQUE(kind, name, project_id));
INSERT INTO assets_old SELECT id, kind, name, description, source, pinned, latest, created_at, updated_at, project_id FROM assets;
DROP TABLE assets; ALTER TABLE assets_old RENAME TO assets;`);
    db.close();

    store = openSqliteStore(path);
    await store.users.save(admin);
    const deps = {
      assets: store.assets,
      users: store.users,
      teams: store.teams,
      review: store.assetReview,
      notifications: store.notifications,
      audit: store.audit,
      secrets: { list: async () => [], put: async () => {}, remove: async () => false, reveal: async () => ({}) },
      now: () => 10
    } as unknown as AssetReviewDeps;
    const counts = { assets: (await store.assets.list()).length, installs: (await store.assets.installations()).length };
    const result = await migrateAssetOwnership(deps);
    assert.deepEqual(result, { migrated: 2, pending: 1 });
    const after = await store.assets.list();
    assert.deepEqual(
      after.map((a) => [a.id, a.scope, a.ownerId, a.teamId, a.projectId]).sort(),
      [['g', 'global', 'u-admin', 't0', null], ['p', 'project', 'u-admin', 't0', 'proj1']]
    );
    assert.deepEqual({ assets: after.length, installs: (await store.assets.installations()).length }, counts);
    assert.deepEqual(await workerAssetManifest(store, 'w1'), before, 'Worker 清单迁移前后完全一致');
    // 未钉的新版本（latest ≠ pinned）转成待审提交，已钉的照常用
    const pending = await store.assetReview.submissions({ status: ['pending'] });
    assert.deepEqual(pending.map((s) => [s.assetId, s.origin, s.digest]), [['g', 'migration', v2.value.digest]]);
    assert.deepEqual(await migrateAssetOwnership(deps), { migrated: 0, pending: 0 });
    store.close();
    store = openSqliteStore(path);
    assert.deepEqual(await workerAssetManifest(store, 'w1'), before);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
