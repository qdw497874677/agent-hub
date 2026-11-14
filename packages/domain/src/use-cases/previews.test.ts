import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import type { Principal, User } from '../account.ts';
import type { TeamId, UserId } from '../account.ts';
import { asLoginId, asTeamId, asUserId } from '../account.ts';
import { asAgentId, type PreviewLinkId } from '../ids.ts';
import { available, capabilityMatrix } from '../capability.ts';
import type { PreviewLink } from '../preview.ts';
import type { PreviewLinkRepository } from '../ports/preview-links.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createAccessPolicy as createAccessPolicyForTests } from './authorization.ts';
import {
  createPreviewLinkUseCase,
  listPreviewLinksUseCase,
  markWorkerPreviewsOfflineUseCase,
  removePreviewLinkUseCase,
  type PreviewDeps,
} from './previews.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';

const fake: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: capabilityMatrix({
    prompt: available,
    interrupt: available,
    fork: available,
    resume: available,
    tool_calls: available,
    artifacts: available,
    structured_events: available,
    attachments: available,
  }),
  models: ['m1'],
  defaultModel: 'm1',
  options: [],
};

function userOf(id: string, teamId: string, options: { role?: User['role']; clusterAdmin?: boolean } = {}): User {
  return {
    id: asUserId(id) as UserId,
    email: `${id}@example.com`,
    displayName: id,
    role: options.role ?? 'owner',
    passwordHash: null,
    emailVerifiedAt: 1,
    disabledAt: null,
    createdAt: 1,
    teamId: asTeamId(teamId) as TeamId,
    clusterAdmin: options.clusterAdmin ?? false,
    deletedAt: null,
  };
}

function principalOf(user: User): Principal {
  return { user, loginId: asLoginId(`login-${user.id}`) };
}

function fakePreviewLinks(): PreviewLinkRepository & { readonly rows: Map<PreviewLinkId, PreviewLink> } {
  const rows = new Map<PreviewLinkId, PreviewLink>();
  return {
    rows,
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async byHubPort(hubPort) {
      return [...rows.values()].find((link) => link.hubPort === hubPort) ?? null;
    },
    async listBySession(sessionId) {
      return [...rows.values()].filter((link) => link.sessionId === sessionId);
    },
    async listAll() {
      return [...rows.values()];
    },
    async save(link) {
      rows.set(link.id, link);
    },
    async remove(id) {
      rows.delete(id);
    },
    async removeBySession(sessionId) {
      for (const [id, link] of rows) if (link.sessionId === sessionId) rows.delete(id);
    },
  };
}

async function world() {
  const w = inMemoryDeps();
  w.agents.push(fake);
  const owner = principalOf(userOf('owner', 'team-1', { clusterAdmin: true }));
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo', actor: owner });
  assert.ok(project.ok, JSON.stringify(project));
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok, JSON.stringify(session));
  const policy = createAccessPolicyForTests({
    users: {
      firstClusterAdmin: async () => owner.user,
      byId: async (id) => (id === owner.user.id ? owner.user : null),
    },
    settings: { get: async () => ({ openRegistration: false, membersCanAddMachines: true, refuseWhenFull: [] }) },
    enrollment: { credentialFor: async () => null },
    gateway: { status: async () => w.workers },
  });
  const previewLinks = fakePreviewLinks();
  const previewDeps: PreviewDeps = {
    ...w.deps,
    access: policy,
    previewLinks,
    previewPorts: { from: 17901, to: 17920 },
  };
  return { ...w, owner, project: project.value, task: task.value, session: session.value, policy, previewDeps, previewLinks };
}

test('建预览链接：pid/端口/标签/hub 端口都按区间分配', async () => {
  const w = await world();
  const created = await createPreviewLinkUseCase(w.previewDeps, w.owner, { sessionId: w.session.id, port: 3000 });
  assert.ok(created.ok, JSON.stringify(created));
  const link = created.value;
  assert.match(link.id, /^pv_[0-9a-f]{8}$/);
  assert.equal(link.sessionId, w.session.id);
  assert.equal(link.workerId, 'local');
  assert.equal(link.port, 3000);
  assert.equal(link.hubPort, 17901);
  assert.equal(link.label, '端口 3000');
  assert.equal(link.source, 'manual');
  assert.equal(link.state, 'ready');
  assert.equal(link.createdAt, link.lastSeenAt);

  const listed = await listPreviewLinksUseCase(w.previewDeps, w.owner, w.session.id);
  assert.ok(listed.ok);
  assert.deepEqual(
    listed.value.map((item) => item.id),
    [link.id],
  );
});

test('建预览链接：同一会话同端口幂等，不再吃端口', async () => {
  const w = await world();
  const first = await createPreviewLinkUseCase(w.previewDeps, w.owner, { sessionId: w.session.id, port: 3000 });
  assert.ok(first.ok);
  const again = await createPreviewLinkUseCase(w.previewDeps, w.owner, { sessionId: w.session.id, port: 3000, label: '改了' });
  assert.ok(again.ok);
  assert.equal(again.value.id, first.value.id);
  assert.equal(again.value.label, '端口 3000');
  assert.equal(w.previewLinks.rows.size, 1);

  const other = await createPreviewLinkUseCase(w.previewDeps, w.owner, { sessionId: w.session.id, port: 3001 });
  assert.ok(other.ok);
  assert.equal(other.value.hubPort, 17902);
});

test('建预览链接：单个会话最多 PREVIEW_LINKS_MAX 条', async () => {
  const w = await world();
  for (let index = 0; index < 9; index += 1) {
    const created = await createPreviewLinkUseCase(w.previewDeps, w.owner, { sessionId: w.session.id, port: 3000 + index });
    if (index < 8) {
      assert.ok(created.ok, JSON.stringify(created));
    } else {
      assert.equal(created.ok, false);
      assert.equal(created.ok === false && created.error.code, 'conflict');
    }
  }
  assert.equal(w.previewLinks.rows.size, 8);
});

test('建预览链接：区间用尽返回 409 conflict', async () => {
  const w = await world();
  const tight: PreviewDeps = { ...w.previewDeps, previewPorts: { from: 18001, to: 18001 } };
  const first = await createPreviewLinkUseCase(tight, w.owner, { sessionId: w.session.id, port: 3000 });
  assert.ok(first.ok);
  assert.equal(first.value.hubPort, 18001);

  const task = await createTaskUseCase(w.deps, { projectId: w.project.id, title: 't2' });
  assert.ok(task.ok);
  const second = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(second.ok);
  const created = await createPreviewLinkUseCase(tight, w.owner, { sessionId: second.value.id, port: 4000 });
  assert.equal(created.ok, false);
  assert.equal(created.ok === false && created.error.code, 'conflict');
  assert.equal(created.ok === false && created.error.message, '预览端口用完了，删掉一条再试');
});

test('建预览链接：previewPortFree 为 false 的端口会被跳过', async () => {
  const w = await world();
  const deps: PreviewDeps = { ...w.previewDeps, previewPorts: { from: 18101, to: 18103 }, previewPortFree: (port) => port !== 18101 };
  const created = await createPreviewLinkUseCase(deps, w.owner, { sessionId: w.session.id, port: 3000 });
  assert.ok(created.ok);
  assert.equal(created.value.hubPort, 18102);
});

test('建预览链接：端口校验', async () => {
  const w = await world();
  const low = await createPreviewLinkUseCase(w.previewDeps, w.owner, { sessionId: w.session.id, port: 80 });
  assert.equal(low.ok, false);
  assert.equal(low.ok === false && low.error.message, '端口不能小于 1024');
  const bad = await createPreviewLinkUseCase(w.previewDeps, w.owner, { sessionId: w.session.id, port: 0 });
  assert.equal(bad.ok, false);
});

test('列/建/删都要过 session.read：别人的会话一律 404', async () => {
  const w = await world();
  const outsider = principalOf(userOf('outsider', 'team-2', { role: 'member' }));
  const created = await createPreviewLinkUseCase(w.previewDeps, w.owner, { sessionId: w.session.id, port: 3000 });
  assert.ok(created.ok);

  const list = await listPreviewLinksUseCase(w.previewDeps, outsider, w.session.id);
  assert.equal(list.ok, false);
  assert.equal(list.ok === false && list.error.code, 'not_found');

  const create = await createPreviewLinkUseCase(w.previewDeps, outsider, { sessionId: w.session.id, port: 3001 });
  assert.equal(create.ok, false);
  assert.equal(create.ok === false && create.error.code, 'not_found');

  const remove = await removePreviewLinkUseCase(w.previewDeps, outsider, w.session.id, created.value.id);
  assert.equal(remove.ok, false);
  assert.equal(remove.ok === false && remove.error.code, 'not_found');
  assert.equal(w.previewLinks.rows.size, 1);
});

test('删预览链接：别人的链接当不存在', async () => {
  const w = await world();
  const created = await createPreviewLinkUseCase(w.previewDeps, w.owner, { sessionId: w.session.id, port: 3000 });
  assert.ok(created.ok);

  const task = await createTaskUseCase(w.deps, { projectId: w.project.id, title: 't2' });
  assert.ok(task.ok);
  const other = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(other.ok);

  const wrong = await removePreviewLinkUseCase(w.previewDeps, w.owner, other.value.id, created.value.id);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.ok === false && wrong.error.code, 'not_found');
  assert.equal(wrong.ok === false && wrong.error.message, '预览链接不存在');

  const gone = await removePreviewLinkUseCase(w.previewDeps, w.owner, w.session.id, 'pv_deadbeef');
  assert.equal(gone.ok, false);
  assert.equal(w.previewLinks.rows.size, 1);

  const removed = await removePreviewLinkUseCase(w.previewDeps, w.owner, w.session.id, created.value.id);
  assert.ok(removed.ok);
  assert.equal(w.previewLinks.rows.size, 0);
});

test('worker 掉线：只把该 worker 的链接标 offline', async () => {
  const w = await world();
  const mine = await createPreviewLinkUseCase(w.previewDeps, w.owner, { sessionId: w.session.id, port: 3000 });
  assert.ok(mine.ok);
  const other = await createPreviewLinkUseCase(w.previewDeps, w.owner, { sessionId: w.session.id, port: 3001 });
  assert.ok(other.ok);
  assert.ok(other.ok);
  await w.previewLinks.save({ ...other.value, workerId: 'remote-x' });

  const changed = await markWorkerPreviewsOfflineUseCase(w.previewDeps, 'local');
  assert.equal(changed, 1);
  const local = await w.previewLinks.byId(mine.value.id);
  assert.equal(local?.state, 'offline');
  const remote = await w.previewLinks.byId(other.value.id);
  assert.equal(remote?.state, 'ready');
  // 再跑一次不重复计数
  assert.equal(await markWorkerPreviewsOfflineUseCase(w.previewDeps, 'local'), 0);
});
