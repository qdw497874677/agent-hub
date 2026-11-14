import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { available, capabilityMatrix } from '../capability.ts';
import { asAgentId, type PreviewLinkId } from '../ids.ts';
import type { PreviewLink } from '../preview.ts';
import type { PreviewLinkRepository } from '../ports/preview-links.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import {
  matchPreviewShare,
  previewLinkPublic,
  previewShareTokenHash,
  revokePreviewShareUseCase,
  sharePreviewLinkUseCase,
  type PreviewShareDeps,
} from './preview-share.ts';
import { createPreviewLinkUseCase } from './previews.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';

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

async function world() {
  const w = inMemoryDeps();
  w.agents.push(fakeAgent);
  let now = T0;
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok, JSON.stringify(project));
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok, JSON.stringify(session));
  const previewLinks = fakePreviewLinks();
  const deps: PreviewShareDeps = {
    ...w.deps,
    previewLinks,
    now: () => now,
  };
  const created = await createPreviewLinkUseCase(
    { ...deps, previewPorts: { from: 17901, to: 17920 } },
    null,
    { sessionId: session.value.id, port: 3000 },
  );
  assert.ok(created.ok, JSON.stringify(created));
  return {
    ...w,
    deps,
    previewLinks,
    session: session.value,
    link: created.value,
    setNow: (value: number) => {
      now = value;
    },
  };
}

test('分享预览：返回一次性明令牌，库里只存 sha256，默认 24 小时', async () => {
  const w = await world();
  const shared = await sharePreviewLinkUseCase(w.deps, null, { sessionId: w.session.id, linkId: w.link.id });
  assert.ok(shared.ok, JSON.stringify(shared));
  assert.match(shared.value.token, /^pvs_[A-Za-z0-9_-]{32}$/);
  assert.equal(shared.value.expiresAt, T0 + 24 * 3_600_000);
  assert.equal(shared.value.link.shareTokenHash, await previewShareTokenHash(shared.value.token));
  assert.match(shared.value.link.shareTokenHash ?? '', /^[0-9a-f]{64}$/);
  assert.notEqual(shared.value.link.shareTokenHash, shared.value.token);

  const stored = await w.previewLinks.byId(w.link.id);
  assert.equal(stored?.shareExpiresAt, T0 + 24 * 3_600_000);
  assert.equal(stored?.shareTokenHash, await previewShareTokenHash(shared.value.token));

  const view = previewLinkPublic(w.deps, stored!);
  assert.equal(view.shared, true);
  assert.equal(view.shareExpiresAt, T0 + 24 * 3_600_000);
  assert.equal('shareTokenHash' in view, false);
});

test('分享预览：重新分享 = 轮换，旧令牌立刻失效', async () => {
  const w = await world();
  const first = await sharePreviewLinkUseCase(w.deps, null, { sessionId: w.session.id, linkId: w.link.id });
  assert.ok(first.ok);
  const second = await sharePreviewLinkUseCase(w.deps, null, {
    sessionId: w.session.id,
    linkId: w.link.id,
    hours: 2,
  });
  assert.ok(second.ok);
  assert.notEqual(second.value.token, first.value.token);
  assert.equal(second.value.expiresAt, T0 + 2 * 3_600_000);

  assert.deepEqual(await matchPreviewShare(w.deps, w.link.id, first.value.token, T0), {
    ok: false,
    reason: 'notfound',
  });
  assert.deepEqual(await matchPreviewShare(w.deps, w.link.id, second.value.token, T0), { ok: true });
});

test('分享预览：有效期越界或缺链接报错', async () => {
  const w = await world();
  const tooLong = await sharePreviewLinkUseCase(w.deps, null, {
    sessionId: w.session.id,
    linkId: w.link.id,
    hours: 721,
  });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.ok === false && tooLong.error.code, 'invalid');

  const zero = await sharePreviewLinkUseCase(w.deps, null, { sessionId: w.session.id, linkId: w.link.id, hours: 0 });
  assert.equal(zero.ok, false);
  assert.equal(zero.ok === false && zero.error.code, 'invalid');

  const missing = await sharePreviewLinkUseCase(w.deps, null, { sessionId: w.session.id, linkId: 'pv_deadbeef' });
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.error.code, 'not_found');
});

test('分享预览：别的会话的链接一律 404，不泄露存在', async () => {
  const w = await world();
  const shared = await sharePreviewLinkUseCase(w.deps, null, {
    sessionId: 'sess-other',
    linkId: w.link.id,
  });
  assert.equal(shared.ok, false);
  assert.equal(shared.ok === false && shared.error.code, 'not_found');
});

test('撤销分享：清空哈希与到期时间，重复撤销幂等', async () => {
  const w = await world();
  const shared = await sharePreviewLinkUseCase(w.deps, null, { sessionId: w.session.id, linkId: w.link.id });
  assert.ok(shared.ok);

  const revoked = await revokePreviewShareUseCase(w.deps, null, { sessionId: w.session.id, linkId: w.link.id });
  assert.ok(revoked.ok);
  assert.equal(revoked.value.shareTokenHash, null);
  assert.equal(revoked.value.shareExpiresAt, null);

  const again = await revokePreviewShareUseCase(w.deps, null, { sessionId: w.session.id, linkId: w.link.id });
  assert.ok(again.ok);
  assert.deepEqual(await matchPreviewShare(w.deps, w.link.id, shared.value.token, T0), {
    ok: false,
    reason: 'notfound',
  });
  assert.equal(previewLinkPublic(w.deps, (await w.previewLinks.byId(w.link.id))!).shared, false);
});

test('校验分享：过期返回 expired，错误令牌 notfound，没分享过 notfound', async () => {
  const w = await world();
  assert.deepEqual(await matchPreviewShare(w.deps, w.link.id, 'pvs_whatever', T0), {
    ok: false,
    reason: 'notfound',
  });

  const shared = await sharePreviewLinkUseCase(w.deps, null, {
    sessionId: w.session.id,
    linkId: w.link.id,
    hours: 1,
  });
  assert.ok(shared.ok);
  assert.deepEqual(await matchPreviewShare(w.deps, w.link.id, 'pvs_wrong', T0), {
    ok: false,
    reason: 'notfound',
  });
  assert.deepEqual(await matchPreviewShare(w.deps, w.link.id, shared.value.token, T0 + 3_600_000), {
    ok: false,
    reason: 'expired',
  });

  w.setNow(T0 + 3_600_001);
  const stored = await w.previewLinks.byId(w.link.id);
  assert.equal(previewLinkPublic(w.deps, stored!).shared, false);
});
