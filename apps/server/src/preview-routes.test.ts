import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import {
  asAgentId,
  available,
  capabilityMatrix,
  createProjectUseCase,
  createTaskUseCase,
  deriveSessionUseCase,
  previewLinkIdFrom,
  type AgentDescriptor,
  type PreviewLink,
  type PreviewLinkId,
  type PreviewLinkRepository,
} from '@agent-hub/domain';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import { installPreviewRoutes, type PreviewAuditAction, type PreviewApiOptions } from './preview-routes.ts';

const fakeAgent: AgentDescriptor = {
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

const T0 = 1_700_000_000_000;

async function world(extra: Partial<PreviewApiOptions> = {}) {
  const w = inMemoryDeps();
  w.agents.push(fakeAgent);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok, JSON.stringify(project));
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok, JSON.stringify(session));

  const previewLinks = fakePreviewLinks();
  const link: PreviewLink = {
    id: previewLinkIdFrom('0a1b2c3d'),
    sessionId: session.value.id,
    workerId: 'local',
    port: 3000,
    hubPort: 17901,
    label: '端口 3000',
    source: 'manual',
    state: 'ready',
    createdAt: T0,
    lastSeenAt: T0,
    shareTokenHash: null,
    shareExpiresAt: null,
  };
  await previewLinks.save(link);

  const audits: Array<{ action: PreviewAuditAction; target: string; detail: string }> = [];
  const app = new Hono();
  installPreviewRoutes(
    app,
    {
      deps: { ...w.deps, previewLinks, now: () => T0 },
      ports: { from: 17901, to: 17920 },
      audit: async (_c, _subject, action, target, detail) => {
        audits.push({ action, target, detail });
      },
      ...extra,
    },
    () => null,
  );
  return { app, audits, link, session: session.value, previewLinks };
}

test('GET 列表：未分享时 DTO 带 shared=false / shareExpiresAt=null', async () => {
  const { app, session } = await world();
  const res = await app.request(`http://hub.local:17900/api/sessions/${session.id}/previews`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { links: Array<Record<string, unknown>> };
  assert.equal(body.links.length, 1);
  assert.equal(body.links[0]!.shared, false);
  assert.equal(body.links[0]!.shareExpiresAt, null);
  assert.equal('shareTokenHash' in body.links[0]!, false);
});

test('POST share：返回一次性的 url + expiresAt，列表随后 shared=true', async () => {
  const { app, audits, link, session } = await world({ publicHost: 'hub.example.com', https: true });
  const res = await app.request(`http://ignored/api/sessions/${session.id}/previews/${link.id}/share`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hours: 2 }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; url: string; expiresAt: number };
  assert.equal(body.ok, true);
  assert.equal(body.expiresAt, T0 + 2 * 3_600_000);
  assert.match(body.url, /^https:\/\/hub\.example\.com:17901\/\?share=pvs_[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(audits.map((entry) => entry.action), ['preview.share']);

  const listed = await app.request(`http://ignored/api/sessions/${session.id}/previews`);
  const listBody = (await listed.json()) as { links: Array<{ shared: boolean; shareExpiresAt: number | null }> };
  assert.equal(listBody.links[0]!.shared, true);
  assert.equal(listBody.links[0]!.shareExpiresAt, T0 + 2 * 3_600_000);
});

test('POST share 不带 body 默认 24 小时；DELETE 撤销后回到未分享', async () => {
  const { app, audits, link, session } = await world();
  const shared = await app.request(`http://hub.local:17900/api/sessions/${session.id}/previews/${link.id}/share`, {
    method: 'POST',
  });
  assert.equal(shared.status, 200);
  const body = (await shared.json()) as { url: string; expiresAt: number };
  assert.equal(body.expiresAt, T0 + 24 * 3_600_000);
  assert.ok(body.url.includes(':17901/?share=pvs_'), body.url);

  const revoked = await app.request(`http://hub.local:17900/api/sessions/${session.id}/previews/${link.id}/share`, {
    method: 'DELETE',
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { ok: true });
  assert.deepEqual(audits.map((entry) => entry.action), ['preview.share', 'preview.unshare']);

  const listed = await app.request(`http://hub.local:17900/api/sessions/${session.id}/previews`);
  const listBody = (await listed.json()) as { links: Array<{ shared: boolean; shareExpiresAt: number | null }> };
  assert.equal(listBody.links[0]!.shared, false);
  assert.equal(listBody.links[0]!.shareExpiresAt, null);
});

test('POST share 的 hours 越界返回 invalid', async () => {
  const { app, link, session } = await world();
  const res = await app.request(`http://hub.local:17900/api/sessions/${session.id}/previews/${link.id}/share`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hours: 999 }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: { code?: string } };
  assert.equal(body.error?.code, 'invalid');
});
