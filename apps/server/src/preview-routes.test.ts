import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import {
  asAgentId,
  asWorkspaceId,
  available,
  capabilityMatrix,
  createProjectUseCase,
  createTaskUseCase,
  deriveSessionUseCase,
  previewLinkIdFrom,
  systemSubject,
  type AgentDescriptor,
  type PreviewLink,
  type PreviewLinkId,
  type PreviewLinkRepository,
} from '@agent-hub/domain';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import { installPreviewRoutes, type PreviewAuditAction, type PreviewApiOptions } from './preview-routes.ts';
import { PreviewStreamError, type PreviewChannel, type PreviewHead } from './preview-channel.ts';

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

async function world(extra: Partial<PreviewApiOptions> = {}, authenticated = false) {
  const w = inMemoryDeps();
  w.agents.push(fakeAgent);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok, JSON.stringify(project));
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok, JSON.stringify(session));

  const previewLinks = fakePreviewLinks();
  previewLinks.insertIfCurrentWorkspace = async (link) => { await previewLinks.save(link); return true; };
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
    () => authenticated ? systemSubject('test') : null,
  );
  return { app, audits, link, session: session.value, project: project.value, previewLinks, deps: w.deps };
}

const fakeProxy: NonNullable<NonNullable<PreviewApiOptions['workflow']>['proxy']> = { listening: () => [{ linkId: 'pv_0a1b2c3d', hubPort: 17901 }], listen: async () => {}, unlisten: async () => {}, listenAll: async () => {}, close: async () => {} };

test('workflow 只登记确认的候选，复用已有链接且使用配置的 HTTP 主机', async () => {
  const workflow: NonNullable<PreviewApiOptions['workflow']> = {
    host: 'preview.example',
    candidates: async () => [{ port: 3000, workerId: 'local', root: '/tmp/demo', workspaceId: asWorkspaceId('w1') }],
    channel: null,
    proxy: { listening: () => [{ linkId: 'pv_0a1b2c3d', hubPort: 17901 }], listen: async () => {}, unlisten: async () => {}, listenAll: async () => {}, close: async () => {} },
    workerOnline: async () => true,
  };
  const { app, session, link, previewLinks } = await world({ workflow }, true);
  const path = `/api/sessions/${session.id}/preview-workflow`;
  const get = await app.request(`http://attacker.example${path}`);
  assert.deepEqual(await get.json(), { available: true, targets: [{ port: 3000, workerId: 'local', label: link.label, linkId: link.id, url: 'http://preview.example:17901/', mapping: 'ready' }] });
  assert.equal(previewLinks.rows.size, 1);
  const post = await app.request(`http://attacker.example${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: 3000 }) });
  assert.equal(post.status, 200);
  assert.equal((await post.json() as { target: { linkId: string } }).target.linkId, link.id);
  assert.equal(previewLinks.rows.size, 1);
  const denied = await app.request(`http://attacker.example${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: 3001 }) });
  assert.equal(denied.status, 409);
  assert.equal(previewLinks.rows.size, 1);
});

test('workflow 未登录不触发候选或诊断', async () => {
  let scans = 0;
  const { app, session, link } = await world({ workflow: { host: 'example.com', candidates: async () => { scans++; return []; }, channel: null, proxy: null, workerOnline: async () => true } });
  assert.equal((await app.request(`http://hub/api/sessions/${session.id}/preview-workflow`)).status, 404);
  assert.equal((await app.request(`http://hub/api/sessions/${session.id}/previews/${link.id}/diagnostic`, { method: 'POST' })).status, 404);
  assert.equal(scans, 0);
});

test('workflow 关闭时 GET 返回可解析的不可用状态', async () => {
  const { app, session } = await world({}, true);
  const path = `http://hub/api/sessions/${session.id}/preview-workflow`;
  const get = await app.request(path);
  assert.deepEqual(await get.json(), { available: false, targets: [] });
  const post = await app.request(path, { method: 'POST' });
  assert.equal(post.status, 404);
  assert.equal((await post.json() as { error: { code: string } }).error.code, 'not_found');
});

test('手动链接无需进程证据可打开，旧 detected 链接必须重新验证', async () => {
  const { app, session, link, previewLinks } = await world({ workflow: { host: 'preview.example', candidates: async () => [], channel: null, proxy: null, workerOnline: async () => true } }, true);
  const path = `http://hub/api/sessions/${session.id}/preview-workflow`;
  const get = await (await app.request(path)).json() as { targets: Array<{ linkId: string }> };
  assert.equal(get.targets[0]?.linkId, link.id);
  const addresses = await (await app.request(`http://hub/api/sessions/${session.id}/previews`)).json() as { addresses: Record<string, string | null> };
  assert.equal(addresses.addresses[link.id], 'http://preview.example:17901/');
  await previewLinks.save({ ...link, source: 'detected' });
  assert.deepEqual((await (await app.request(path)).json() as { targets: unknown[] }).targets, []);
});

test('并发手动与 workflow 创建同端口只产生一条链接', async () => {
  const workflow: NonNullable<PreviewApiOptions['workflow']> = { host: 'preview.example', candidates: async () => [{ port: 3001, workerId: 'local', root: '/tmp/demo', workspaceId: asWorkspaceId('w1') }], channel: null, proxy: fakeProxy, workerOnline: async () => true };
  const { app, session, previewLinks } = await world({ workflow }, true);
  const opts = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: 3001 }) };
  const [manual, automatic] = await Promise.all([app.request(`http://hub/api/sessions/${session.id}/previews`, opts), app.request(`http://hub/api/sessions/${session.id}/preview-workflow`, opts)]);
  assert.equal(manual.status, 201);
  assert.equal(automatic.status, 200);
  assert.equal([...previewLinks.rows.values()].filter((item) => item.port === 3001).length, 1);
});

test('workflow 缺少可用主机或代理时拒绝手工提交且不扫描、不写入', async () => {
  for (const [host, proxy] of [[null, fakeProxy], ['', fakeProxy], ['preview.example', null]] as const) {
    let scans = 0;
    const { app, session, previewLinks } = await world({ workflow: { host, proxy, channel: null, candidates: async () => { scans++; return [{ port: 3001, workerId: 'local', root: '/tmp/demo', workspaceId: asWorkspaceId('w1') }]; }, workerOnline: async () => true } }, true);
    const res = await app.request(`http://hub/api/sessions/${session.id}/preview-workflow`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: 3001 }) });
    assert.equal(res.status, 409);
    assert.equal(scans, 0);
    assert.equal(previewLinks.rows.size, 1);
  }
});

test('workflow 新建要求清单中的目录与会话位置精确一致', async () => {
  let root = '/tmp/old';
  const workflow: NonNullable<PreviewApiOptions['workflow']> = { host: 'preview.example', proxy: fakeProxy, channel: null, candidates: async () => [{ port: 3001, workerId: 'local', root, workspaceId: asWorkspaceId('w1') }], workerOnline: async () => true };
  const { app, session, previewLinks } = await world({ workflow }, true);
  const path = `http://hub/api/sessions/${session.id}/preview-workflow`;
  const opts = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: 3001 }) };
  assert.equal((await app.request(path, opts)).status, 409);
  assert.equal(previewLinks.rows.size, 1);
  root = '/tmp/demo';
  assert.equal((await app.request(path, opts)).status, 200);
  assert.equal([...previewLinks.rows.values()].filter((item) => item.port === 3001 && item.workerId === 'local').length, 1);
});

test('workflow 无原子条件插入能力时不退回普通写入', async () => {
  const workflow: NonNullable<PreviewApiOptions['workflow']> = { host: 'preview.example', proxy: fakeProxy, channel: null, candidates: async () => [{ port: 3001, workerId: 'local', root: '/tmp/demo', workspaceId: asWorkspaceId('w1') }], workerOnline: async () => true };
  const { app, session, previewLinks } = await world({ workflow }, true);
  delete previewLinks.insertIfCurrentWorkspace;
  const res = await app.request(`http://hub/api/sessions/${session.id}/preview-workflow`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: 3001 }) });
  assert.equal(res.status, 409);
  assert.equal(previewLinks.rows.size, 1);
});

test('workflow 扫描或登记期间工作空间更换机器或目录时不写入', async () => {
  for (const stage of ['scan-worker', 'scan-root', 'registration-worker', 'registration-root'] as const) {
    let mutate = async () => {};
    const workflow: NonNullable<PreviewApiOptions['workflow']> = { host: 'preview.example', proxy: fakeProxy, channel: null, candidates: async () => { if (stage.startsWith('scan')) await mutate(); return [{ port: 3001, workerId: 'local', root: '/tmp/demo', workspaceId: asWorkspaceId('w1') }]; }, workerOnline: async () => true };
    const { app, session, project, previewLinks, deps } = await world({ workflow }, true);
    mutate = async () => {
      const space = (await deps.workspaces.byProject(project.id))[0]!;
      await deps.workspaces.save({ ...space, ...(stage.endsWith('worker') ? { workerId: 'other' } : { path: '/tmp/changed' }) });
    };
    if (stage.startsWith('registration')) {
      const listAll = previewLinks.listAll;
      previewLinks.listAll = async () => { const result = await listAll(); await mutate(); return result; };
    }
    const res = await app.request(`http://hub/api/sessions/${session.id}/preview-workflow`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: 3001 }) });
    assert.equal(res.status, 409, stage);
    assert.equal(previewLinks.rows.size, 1, stage);
  }
});

test('诊断拒绝过期机器，且请求期间位置变更时不返回旧结果', async () => {
  let opens = 0;
  let mutate = async () => {};
  const token = {};
  const channel: PreviewChannel = {
    handleUpgrade() {}, hasWorker: () => true, connectionToken: () => token, streamCount: () => 0, close() {},
    async open() { opens++; await mutate(); return { streamId: 'one', onHead: (callback) => callback({ status: 200, statusText: 'OK', headers: [] }), onData() {}, onEnd() {}, onError() {}, write() {}, endBody() {}, ack() {}, close() {} }; },
  };
  const workflow: NonNullable<PreviewApiOptions['workflow']> = { host: 'preview.example', proxy: fakeProxy, channel, candidates: async () => [], workerOnline: async () => true };
  const { app, session, project, link, previewLinks, deps } = await world({ workflow }, true);
  const path = `http://hub/api/sessions/${session.id}/previews/${link.id}/diagnostic`;
  await previewLinks.save({ ...link, workerId: 'obsolete' });
  assert.equal((await app.request(path, { method: 'POST' })).status, 404);
  assert.equal(opens, 0);
  await previewLinks.save(link);
  mutate = async () => { const space = (await deps.workspaces.byProject(project.id))[0]!; await deps.workspaces.save({ ...space, path: '/tmp/changed' }); };
  assert.equal((await app.request(path, { method: 'POST' })).status, 404);
  assert.equal(opens, 1);
});

test('诊断只对当前链接发 HEAD /，HTTP 响应不代表后端 API 健康', async () => {
  let request: unknown;
  const token = {};
  const channel: PreviewChannel = {
    handleUpgrade() {}, hasWorker: () => true, connectionToken: () => token, streamCount: () => 0, close() {},
    async open(_worker, value) {
      request = value;
      return { streamId: 'one', onHead: (callback: (head: PreviewHead) => void) => callback({ status: 200, statusText: 'OK', headers: [] }), onData() {}, onEnd() {}, onError() {}, write() {}, endBody() {}, ack() {}, close() {} };
    },
  };
  const proxy: NonNullable<NonNullable<PreviewApiOptions['workflow']>['proxy']> = { listening: () => [{ linkId: 'pv_0a1b2c3d', hubPort: 17901 }], listen: async () => {}, unlisten: async () => {}, listenAll: async () => {}, close: async () => {} };
  const { app, session, link } = await world({ workflow: { host: 'preview.example', candidates: async () => [], channel, proxy, workerOnline: async () => true } }, true);
  const res = await app.request(`http://hub/api/sessions/${session.id}/previews/${link.id}/diagnostic`, { method: 'POST' });
  assert.deepEqual(request, { port: 3000, method: 'HEAD', path: '/', headers: [] });
  assert.deepEqual(await res.json(), { state: 'response', status: 200, checkedAt: T0 });
});

test('诊断拒绝连接与通道重连分别报告 refused 和 indeterminate', async () => {
  let token: object = {};
  let reconnect = false;
  const channel: PreviewChannel = {
    handleUpgrade() {}, hasWorker: () => true, connectionToken: () => token, streamCount: () => 0, close() {},
    async open() {
      return { streamId: 'one', onHead() {}, onData() {}, onEnd() {}, onError(callback) { if (reconnect) token = {}; callback(new PreviewStreamError(502, 'refused', 'refused')); }, write() {}, endBody() {}, ack() {}, close() {} };
    },
  };
  const proxy: NonNullable<NonNullable<PreviewApiOptions['workflow']>['proxy']> = { listening: () => [{ linkId: 'pv_0a1b2c3d', hubPort: 17901 }], listen: async () => {}, unlisten: async () => {}, listenAll: async () => {}, close: async () => {} };
  const { app, session, link } = await world({ workflow: { host: 'preview.example', candidates: async () => [], channel, proxy, workerOnline: async () => true } }, true);
  const path = `http://hub/api/sessions/${session.id}/previews/${link.id}/diagnostic`;
  assert.equal((await (await app.request(path, { method: 'POST' })).json() as { state: string }).state, 'refused');
  reconnect = true;
  assert.equal((await (await app.request(path, { method: 'POST' })).json() as { state: string }).state, 'indeterminate');
});

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

test('GET 列表：一条不合契约的旧数据被跳过，其它链接照常返回', async () => {
  const { app, session, previewLinks } = await world();
  const bad = {
    ...([...previewLinks.rows.values()][0]!),
    id: 'pv_21a70f2207ac64dd' as PreviewLinkId,
    hubPort: 17902
  };
  await previewLinks.save(bad);

  const res = await app.request(`http://hub.local:17900/api/sessions/${session.id}/previews`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { links: Array<{ id: string }> };
  assert.equal(body.links.length, 1);
  assert.notEqual(body.links[0]!.id, bad.id);
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
