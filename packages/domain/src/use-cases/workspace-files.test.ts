import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import type { AuditEntry } from '../account.ts';
import { asAgentId } from '../ids.ts';
import { capabilityMatrix, available } from '../capability.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { ok } from '../result.ts';
import { isCheckpointPrefix, isCheckpointRef, type CheckpointStore, type TurnCheckpoint, type WorkspaceBrowser } from '../ports/workspace-browser.ts';
import { isBrowsablePath, isSensitivePath, looksBinary, isCommitId, withoutSensitiveDiff } from '../workspace-files.ts';
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
    read: async (_root, path) => (calls.push(`${tag}:read:${path}`), ok({ path, size: 1, modifiedAt: 0, binary: false, truncated: false, bytes: new Uint8Array([65]) })),
    find: async () => ok(['a.ts']),
    changes: async (_root, base, target) => (calls.push(`${tag}:changes:${base}${target ? `..${target}` : ''}`), ok(target ? [{ path: 'a.ts', status: 'modified' as const, additions: 2, deletions: 1 }] : [])),
    diff: async (_root, path, base, _max, target) => (calls.push(`${tag}:diff:${path}:${base}${target ? `..${target}` : ''}`), ok({ path, patch: '', truncated: false, binary: false })),
    checkpoint: async (_root, ref) => (calls.push(`${tag}:checkpoint:${ref.split('/').at(-1)}`), ok(`c0ffee${ref.split('/').at(-1)}`)),
    dropRefs: async (_root, prefix) => (calls.push(`${tag}:drop:${prefix.split('/').length}`), ok(2)),
    restore: async (_root, commit) => (calls.push(`${tag}:restore:${commit}`), ok({ safety: 'safe', restored: 1, removed: 0 })),
    head: async () => ok('abc1234'),
    branchBase: async () => (calls.push(`${tag}:branchBase`), ok({ branch: 'main', commit: 'abc1234' })),
    watch: async (_root, paths) => (calls.push(`${tag}:watch:${paths.join(',')}`), ok(() => calls.push(`${tag}:unwatch`)))
  };
}

function memoryCheckpoints(): CheckpointStore {
  const rows: TurnCheckpoint[] = [];
  return {
    list: async (id) => rows.filter((r) => r.sessionId === id),
    begin: async (row) => void rows.push({ ...row, after: null, endedAt: null, files: null, additions: null, deletions: null }),
    end: async (id, turn, row) => {
      const i = rows.findIndex((r) => r.sessionId === id && r.turn === turn);
      if (i >= 0) rows[i] = { ...rows[i]!, ...row };
    },
    staleSessions: async (cutoff) => [...new Set(rows.filter((r) => (r.endedAt ?? r.startedAt) < cutoff).map((r) => r.sessionId))],
    remove: async (id) => void rows.splice(0, rows.length, ...rows.filter((r) => r.sessionId !== id))
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
    checkpoints: memoryCheckpoints(),
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

test('withoutSensitiveDiff：整段剔除敏感文件与改名/复制源，正常改动保留（#269）', () => {
  const allowed = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new'
  ].join('\n');
  assert.equal(withoutSensitiveDiff(''), '');
  assert.equal(withoutSensitiveDiff(allowed), allowed);
  assert.equal(withoutSensitiveDiff(`${allowed}\n`), `${allowed}\n`);

  const secret = [
    'diff --git a/.env b/.env',
    '--- a/.env',
    '+++ b/.env',
    '@@ -1 +1 @@',
    '-SECRET=old-not-real',
    '+SECRET=new-not-real'
  ].join('\n');
  assert.equal(withoutSensitiveDiff(`${secret}\n${allowed}`), allowed);
  assert.equal(withoutSensitiveDiff(`${allowed}\n${secret}`), allowed);
  assert.equal(withoutSensitiveDiff(`${secret}\n${allowed}\n${secret}`), allowed);
  // 旧 Worker 的未跟踪名单：敏感名字去掉，正常名字保留
  assert.equal(withoutSensitiveDiff('新文件：.env'), '');
  assert.equal(withoutSensitiveDiff(`${allowed}\n新文件：keys/id_rsa`), allowed);
  assert.equal(withoutSensitiveDiff(`${allowed}\n新文件：notes.txt`), `${allowed}\n新文件：notes.txt`);

  // 改名/复制：源或目标命中就丢整节（旧名可能在另一段）
  const renameAway = [
    'diff --git a/.env b/config.txt',
    'similarity index 100%',
    'rename from .env',
    'rename to config.txt'
  ].join('\n');
  assert.equal(withoutSensitiveDiff(renameAway), '');
  const renameInto = [
    'diff --git a/config.txt b/keys/id_rsa',
    'similarity index 80%',
    'rename from config.txt',
    'rename to keys/id_rsa'
  ].join('\n');
  assert.equal(withoutSensitiveDiff(renameInto), '');
  const copyFrom = [
    'diff --git a/.env b/notes.txt',
    'similarity index 100%',
    'copy from .env',
    'copy to notes.txt'
  ].join('\n');
  assert.equal(withoutSensitiveDiff(copyFrom), '');

  // 引号路径 / 空格 / 非 ASCII：解码后再按文件名判断；正常文件原样保留
  const quoted = [
    'diff --git "a/keys/server.pem" "b/keys/server.pem"',
    '--- "a/keys/server.pem"',
    '+++ "b/keys/server.pem"',
    '@@ -1 +1 @@',
    '-x',
    '+y'
  ].join('\n');
  assert.equal(withoutSensitiveDiff(quoted), '');
  const spaced = [
    'diff --git a/has space.txt b/has space.txt',
    '--- a/has space.txt\t',
    '+++ b/has space.txt\t',
    '@@ -1 +1 @@',
    '-x',
    '+y'
  ].join('\n');
  assert.equal(withoutSensitiveDiff(spaced), spaced);
  const unicode = [
    'diff --git "a/docs/\\303\\274ber.txt" "b/docs/\\303\\274ber.txt"',
    '--- "a/docs/\\303\\274ber.txt"',
    '+++ "b/docs/\\303\\274ber.txt"',
    '@@ -1 +1 @@',
    '-x',
    '+y'
  ].join('\n');
  assert.equal(withoutSensitiveDiff(unicode), unicode);

  // 非敏感近似名不误伤
  const nearMiss = 'diff --git a/env.ts b/env.ts\n--- a/env.ts\n+++ b/env.ts\n@@ -1 +1 @@\n-x\n+y';
  assert.equal(withoutSensitiveDiff(nearMiss), nearMiss);

  // 没有 diff --git 头也保守处理（拼不出来就整体丢）
  const headerless = '--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-x\n+y';
  assert.equal(withoutSensitiveDiff(headerless), '');

  // 大节不能因为 kept.push(...section) 撞上参数个数上限
  const big = ['diff --git a/src/big.ts b/src/big.ts', '--- a/src/big.ts', '+++ b/src/big.ts', '@@ -0,0 +1 @@', ...Array(150_000).fill('+line')].join('\n');
  assert.equal(withoutSensitiveDiff(big), big);
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

test('branch 基准：用默认分支的 merge-base 比工作区，响应带上分支名', async () => {
  const w = await world();
  const got = await w.svc.changes(null, w.session.id, 'branch');
  assert.ok(got.ok);
  assert.equal(got.value.base, 'branch');
  assert.equal(got.value.commit, 'abc1234');
  assert.equal(got.value.branch, 'main');
  assert.ok(w.calls.includes('local:branchBase'));
  const d = await w.svc.diff(null, w.session.id, 'a.ts', 'branch');
  assert.ok(d.ok);
  assert.ok(w.calls.includes('local:diff:a.ts:abc1234'));
});

test('限流：开头可连续 40 次，第 41 次拒绝；每秒补 20；watch 最多 200 个点', async () => {
  const w = await world();
  for (let i = 0; i < 40; i++) assert.ok((await w.svc.find(null, w.session.id, 'a')).ok, `第 ${i + 1} 次`);
  const limited = await w.svc.find(null, w.session.id, 'a');
  assert.equal(limited.ok, false);
  if (!limited.ok) assert.equal(limited.error.message, '请求太频繁，稍后再试');
  w.tick(1000);
  assert.ok((await w.svc.find(null, w.session.id, 'a')).ok);
  assert.equal((await w.svc.watch(null, w.session.id, Array.from({ length: 201 }, (_, i) => `d${i}`), () => undefined)).ok, false);
  const watched = await w.svc.watch(null, w.session.id, ['', 'src'], () => undefined);
  assert.ok(watched.ok);
  watched.value();
  assert.deepEqual(w.calls.slice(-2), ['local:watch:,src', 'local:unwatch']);
});

test('回合检查点：开始 / 结束各拍一张，本轮 = 前 → 后，进行中 = 前 → 工作区；没收尾的上一轮先收掉', async () => {
  const w = await world();
  const sid = w.session.id;
  assert.equal((await w.svc.changes(null, sid, 'turn')).ok, false); // 还没有回合
  const first = await w.svc.beginTurn(sid, 1);
  assert.equal(first?.turn, 1);
  const live = await w.svc.changes(null, sid, 'turn');
  assert.ok(live.ok);
  assert.equal(live.value.target, null);
  assert.ok(w.calls.includes('local:changes:c0ffee1'));
  w.tick(10);
  await w.svc.endTurn(sid);
  const turns = await w.svc.turns(null, sid);
  assert.ok(turns.ok);
  assert.deepEqual(turns.value.map((t) => [t.turn, t.before, t.after, t.files, t.additions, t.deletions]), [[1, 'c0ffee1', 'c0ffee2', 1, 2, 1]]);
  const done = await w.svc.changes(null, sid, 'turn', 1);
  assert.ok(done.ok);
  assert.equal(done.value.files.length, 1);
  assert.ok((await w.svc.diff(null, sid, 'a.ts', 'turn', 1)).ok);
  assert.ok(w.calls.includes('local:diff:a.ts:c0ffee1..c0ffee2'));
  // 第二轮开了没收（ended 丢了），第三轮开始时先把第二轮收掉
  await w.svc.beginTurn(sid, 5);
  await w.svc.beginTurn(sid, 9);
  const after = await w.svc.turns(null, sid);
  assert.ok(after.ok);
  assert.deepEqual(after.value.map((t) => [t.turn, t.promptSeq, t.after !== null]), [[1, 1, true], [2, 5, true], [3, 9, false]]);
  assert.equal((await w.svc.changes(null, sid, 'turn', 42)).ok, false);
  // 从第二轮那条问话重来：恢复到第二轮开始前的检查点
  assert.equal((await w.svc.turnFor(sid, 5))?.turn, 2);
  const restored = await w.svc.restoreTurn(sid, 5);
  assert.ok(restored.ok && restored.value.turn === 2);
  assert.ok(w.calls.includes('local:restore:c0ffee3'));
  const missing = await w.svc.restoreTurn(sid, 4);
  assert.ok(!missing.ok && missing.error.code === 'not_found');
});

test('检查点保留期：30 天后连 ref 带行一起删；运行中的会话不动', async () => {
  const w = await world();
  const sid = w.session.id;
  await w.svc.beginTurn(sid, 1);
  await w.svc.endTurn(sid);
  assert.equal(await w.svc.sweepCheckpoints(), 0);
  w.tick(31 * 24 * 3600 * 1000);
  const running = await w.deps.sessions.byId(sid);
  await w.deps.sessions.save({ ...running!, status: 'running' });
  assert.equal(await w.svc.sweepCheckpoints(), 0);
  await w.deps.sessions.save({ ...running!, status: 'done' });
  assert.equal(await w.svc.sweepCheckpoints(), 1);
  assert.ok(w.calls.some((c) => c.startsWith('local:drop:')));
  const turns = await w.svc.turns(null, sid);
  assert.ok(turns.ok);
  assert.equal(turns.value.length, 0);
});

test('检查点 ref 规则：只认 refs/agent-hub/checkpoints/<会话>/<n>', () => {
  assert.ok(isCheckpointRef('refs/agent-hub/checkpoints/abc-1/3'));
  for (const bad of ['refs/heads/main', 'refs/agent-hub/checkpoints/../x/1', 'refs/agent-hub/checkpoints/a/b', 'HEAD']) assert.ok(!isCheckpointRef(bad), bad);
  assert.ok(isCheckpointPrefix('refs/agent-hub/checkpoints/abc/'));
  assert.ok(!isCheckpointPrefix('refs/agent-hub/checkpoints/'));
});
