import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asProjectId, asUserId, type Asset, type Principal, type Project } from '@agent-hub/domain';
import { createAssetVisibility } from './asset-visibility.ts';

const actor: Principal = {
  user: {
    id: asUserId('u1'),
    email: 'qdw@example.com',
    displayName: 'qdw',
    role: 'owner',
    passwordHash: null,
    emailVerifiedAt: 1,
    disabledAt: null,
    createdAt: 1,
    teamId: 't1' as Principal['user']['teamId'],
    clusterAdmin: false,
    deletedAt: null
  },
  loginId: 'l1' as Principal['loginId']
};

const project: Project = {
  id: asProjectId('p1'),
  name: 'p1',
  repo: null,
  repos: [],
  description: '',
  checks: [],
  createdAt: 1,
  teamId: 't1' as Project['teamId'],
  createdBy: actor.user.id,
  members: [],
  worktree: { mode: 'shared', setup: null },
  previewPort: null,
  assetSetIds: [],
  deletedAt: null
};

const asset = (patch: Partial<Asset>): Asset => ({
  id: 'a1',
  kind: 'skill',
  name: 'greeter',
  projectId: null,
  scope: 'global',
  ownerId: actor.user.id,
  teamId: 't1' as Asset['teamId'],
  description: '',
  source: { type: 'upload' },
  pinned: 'd1',
  latest: 'd1',
  createdAt: 1,
  updatedAt: 1,
  ...patch
});

const visible = createAssetVisibility(
  {
    projects: {
      byId: async (id) => (id === project.id ? project : null)
    }
  },
  actor
);

test('资产可见性：全局/团队/个人/项目各按归属判定', async () => {
  assert.equal(await visible(asset({})), true, 'global 所有人可见');
  assert.equal(await visible(asset({ scope: 'team' })), true, '同团队可见');
  assert.equal(await visible(asset({ scope: 'team', teamId: 't2' as Asset['teamId'] })), false, '外团队不可见');
  assert.equal(await visible(asset({ scope: 'personal' })), true, '作者本人可见');
  assert.equal(await visible(asset({ scope: 'personal', ownerId: asUserId('u2') })), false, '别人的个人资产不可见');
  assert.equal(await visible(asset({ scope: 'project', projectId: project.id })), true, '项目可读即可见');
  assert.equal(await visible(asset({ scope: 'project', projectId: 'nope' })), false, '项目不存在不可见');
  assert.equal(await visible(asset({ scope: 'project', projectId: null })), false, '项目级却没有项目不可见');
});

test('资产可见性：回收站里的项目不可见；没有 asset.read 的人一律不可见', async () => {
  const trashed = { ...project, deletedAt: 2 };
  const reader = createAssetVisibility({ projects: { byId: async () => trashed } }, actor);
  assert.equal(await reader(asset({ scope: 'project', projectId: project.id })), false);

  const viewer: Principal = { ...actor, user: { ...actor.user, role: 'viewer' } };
  const denied = createAssetVisibility({ projects: { byId: async () => project } }, viewer);
  assert.equal(await denied(asset({})), true, 'viewer 也能读全局资产');
});
