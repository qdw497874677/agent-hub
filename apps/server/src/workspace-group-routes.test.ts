import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { asProjectId, asWorkspaceGroupId, asWorkspaceId, type AccessPolicy, type Project, type Subject, type WorkspaceGroup, type WorkspaceGroupDeps } from '@agent-hub/domain';
import { installWorkspaceGroupRoutes } from './workspace-group-routes.ts';

test('group routes authorize scoped reads and mutations and project only approved fields', async () => {
  const project: Project = { id: asProjectId('p'), name: 'Project', repo: null, repos: [], description: null, createdAt: 1,
    teamId: 'team', createdBy: 'owner', members: [], worktree: null, checks: [], assetSetIds: [], deletedAt: null };
  const member = { workspaceId: asWorkspaceId('w'), repoId: null, sourceWorkspaceId: asWorkspaceId('source'), name: 'repo', state: 'ready' as const, error: null, secret: 'member-secret' };
  const groupWithExtra = { id: asWorkspaceGroupId('g'), projectId: project.id, workerId: 'worker', root: '/private/root',
    members: [member], layout: 'amp' as const, primaryWorkspaceId: member.workspaceId, ownerTaskId: null, state: 'ready' as const, createdAt: 1, error: null, secret: 'group-secret' };
  const group: WorkspaceGroup = groupWithExtra;
  const access: AccessPolicy = { context: async () => ({ hubTeamId: 'team', settings: { membersCanAddMachines: true } }), worker: async () => ({ kind: 'worker', id: 'worker', teamId: 'team' }) };
  const deps = { access, projects: { byId: async () => project }, workspaceGroups: { byId: async () => group } } as unknown as WorkspaceGroupDeps;
  let subject = { user: { id: 'other', role: 'member', teamId: 'other-team', clusterAdmin: false, disabledAt: null, deletedAt: null } } as Subject;
  const app = new Hono();
  installWorkspaceGroupRoutes(app, { deps }, () => subject);
  for (const [method, path] of [['GET', '/api/workspace-groups/g'], ['POST', '/api/workspace-groups/g/retry'], ['POST', '/api/workspace-groups/g/members']] as const) {
    const response = await app.request(path, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repoId: 'x' }) } : {}) });
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /private|source|secret/);
  }
  subject = { user: { id: 'owner', role: 'member', teamId: 'team', clusterAdmin: false, disabledAt: null, deletedAt: null } } as Subject;
  const response = await app.request('/api/workspace-groups/g');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /source/);
  assert.doesNotMatch(body, /secret/);
});
