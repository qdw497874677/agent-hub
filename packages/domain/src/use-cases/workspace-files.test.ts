import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import type { AuditEntry } from '../account.ts';
import { asAgentId } from '../ids.ts';
import { capabilityMatrix, available } from '../capability.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { ok } from '../result.ts';
import type { WorkspaceBrowser } from '../ports/workspace-browser.ts';
import { isBrowsablePath, isSensitivePath, looksBinary, isCommitId } from '../workspace-files.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { createWorkspaceFilesService } from './workspace-files.ts';

const agent: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: capabilityMatrix({ prompt: available, interrupt: available, fork: available, resume: available, tool_calls: available, artifacts: available, structured_events: available, attachments: available }),
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

function fakeBrowser(tag: string, calls: string[]): WorkspaceBrowser {
  return {
    list: async (root, path) => (calls.push(`${tag}:list:${root}:${path}`), ok({ path, entries: [], truncated: false, isGit: true })),
    read: async (root, path) => (calls.push(`${tag}:read:${path}`), ok({ path, size: 1, modifiedAt: 0, binary: false, truncated: false, bytes: new Uint8Array([65]) })),
    find: async () => ok(['a.ts']),
    changes: async (_root, base) => (calls.push(`${tag}:changes:${base}`), ok([])),
    diff: async (_root, path, base) => (calls.push(`${tag}:diff:${path}:${base}`), ok({ path, patch: '', truncated: false, binary: false })),
    head: async () => ok('abc1234'),
    watch: async (_root, paths) => (calls.push(`${tag}:watch:${paths.join(',')}`), ok(() => calls.push(`${tag}:unwatch`)))
  };
}

async function world() {
  const w = inMemoryDeps({ now: () => 1000 });
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo/' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  const calls: string[] = [];
  const audits: AuditEntry[] = [];
  const bases = new Map<string, string>();
  let clock = 1000;
  const svc = createWorkspaceFilesService({
    ...w.deps,
    audit: { append: async (e) => void audits.push(e) },
    local: fakeBrowser('local', calls),
    remote: (id) => fakeBrowser(id, calls),
    bases: { get: async (id) => bases.get(id) ?? null, setIfAbsent: async (id, h) => void (bases.has(id) || bases.set(id, h)) },
    now: () => clock
  });
  return { ...w, svc, calls, audits, bases, session: session.value, project: project.value, tick: (ms: number) => (clock += ms) };
}

test('路径 / 敏感 / 二进制 / 提交号规则', () => {
  for (const good of ['', 'a', 'src/a.ts', '.github/x.yml', '.env']) assert.ok(isBrowsablePath(good), good);
  for (const bad of ['/etc', '../x', 'a/../b', 'a//b', '.git', 'a/.git/config', 'a\\b', 'a\0b', './a']) assert.ok(!isBrowsablePath(bad), bad);
  for (const s of ['.env', '.env.local', 'a/server.pem', 'k.key', 'id_rsa', 'id_rsa.pub', 'id_ed25519', 'c.p12']) assert.ok(isSensitivePath(s), s);
  for (const s of ['env.ts', 'keys.ts', 'a.pem.md']) assert.ok(!isSensitivePath(s), s);
  assert.ok(looksBinary(new Uint8Array([1, 0])));
  assert.ok(!looksBinary(new TextEncoder().encode('hi')));
  assert.ok(isCommitId('abc1234') && !isCommitId('HEAD') && !isCommitId('--output=x'));
});

test('本机工作空间直接读；远端问那台 Worker；路径不合法先拦', async () => {
  const w = await world();
  assert.ok((await w.svc.list(null, w.session.id, 'src')).ok);
  assert.deepEqual(w.calls, ['local:list:/tmp/demo:src']);
  assert.equal((await w.svc.list(null, w.session.id, '../etc')).ok, false);
  assert.equal((await w.svc.read(null, w.session.id, '.git/config', false)).ok, false);
  assert.equal((await w.svc.list(null, 'nope', '')).ok, false);
  for (const workspace of await w.deps.workspaces.byProject(w.project.id)) await w.deps.workspaces.save({ ...workspace, workerId: 'remote-1' });
  w.calls.length = 0;
  assert.ok((await w.svc.read(null, w.session.id, 'a.ts', false)).ok);
  assert.deepEqual(w.calls, ['remote-1:read:a.ts']);
});

test('敏感文件：不确认拒绝；确认后读并留审计；diff 不给看', async () => {
  const w = await world();
  const refused = await w.svc.read(null, w.session.id, 'config/.env', false);
  assert.equal(refused.ok, false);
  assert.equal(w.audits.length, 0);
  assert.ok((await w.svc.read(null, w.session.id, 'config/.env', true)).ok);
  assert.deepEqual(w.audits.map((a) => [a.action, a.target, a.detail]), [['workspace.files.sensitive', w.session.id, '预览 config/.env']]);
  assert.equal((await w.svc.diff(null, w.session.id, '.env', 'head')).ok, false);
});

test('diff 基准：session = 开始时记下的 HEAD（没记就 null=当前 HEAD），head = 当前 HEAD；只记一次', async () => {
  const w = await world();
  await w.svc.changes(null, w.session.id, 'session');
  await w.svc.recordBase(w.session.id);
  await w.svc.recordBase(w.session.id);
  assert.equal(w.bases.get(w.session.id), 'abc1234');
  await w.svc.changes(null, w.session.id, 'session');
  await w.svc.diff(null, w.session.id, 'a.ts', 'head');
  assert.deepEqual(w.calls, ['local:changes:null', 'local:changes:abc1234', 'local:diff:a.ts:null']);
  const ctx = await w.svc.context(null, w.session.id);
  assert.ok(ctx.ok && ctx.value.sessionBase === 'abc1234' && ctx.value.root === '/tmp/demo');
});

test('限流：每人每秒 20 次；watch 最多 200 个点', async () => {
  const w = await world();
  for (let i = 0; i < 20; i++) assert.ok((await w.svc.find(null, w.session.id, 'a')).ok);
  const limited = await w.svc.find(null, w.session.id, 'a');
  assert.equal(limited.ok, false);
  w.tick(1000);
  assert.ok((await w.svc.find(null, w.session.id, 'a')).ok);
  assert.equal((await w.svc.watch(null, w.session.id, Array.from({ length: 201 }, (_, i) => `d${i}`), () => undefined)).ok, false);
  const watched = await w.svc.watch(null, w.session.id, ['', 'src'], () => undefined);
  assert.ok(watched.ok);
  watched.value();
  assert.deepEqual(w.calls.slice(-2), ['local:watch:,src', 'local:unwatch']);
});
