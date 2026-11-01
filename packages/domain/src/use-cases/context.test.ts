import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProject } from '../project.ts';
import { createTask } from '../task.ts';
import { deriveSession } from '../session.ts';
import { asAgentId } from '../ids.ts';
import type { AuditEntry } from '../account.ts';
import type { ContextSetting, ContextSettingsStore } from '../ports/context-settings.ts';
import { recordEvent } from './sessions.ts';
import { createContextService } from './context.ts';
import { compactionStrategy, contextCapabilityOf, estimateContextUsage, resolveContextStrategy, type ContextStrategy } from '../context-strategy.ts';

const pruning: ContextStrategy = { id: 'context-pruning', version: '0', title: 'x', modes: ['runtime-plugin'], initialState: () => ({ schemaVersion: 1, data: null }), replay: async () => ({ schemaVersion: 1, data: null }) };

test('选策略：会话 > 角色 > 项目 > hub；运行时不支持 / 没安装 / 项目没启用都退回 compaction', () => {
  const capability = contextCapabilityOf('pi');
  const none = resolveContextStrategy({ layers: {}, capability });
  assert.equal(none.strategy.id, 'compaction');
  assert.equal(none.mode, 'native');
  assert.equal(none.source, 'default');
  const hub = resolveContextStrategy({ layers: { hub: { strategy: 'compaction' }, project: { strategy: 'compaction' } }, capability });
  assert.equal(hub.source, 'project');
  const notInstalled = resolveContextStrategy({ layers: { session: { strategy: 'nope' } }, capability });
  assert.deepEqual(notInstalled.fallback, { wanted: 'nope', reason: '这个策略没安装' });
  const unsupported = resolveContextStrategy({ layers: { role: { strategy: 'context-pruning' } }, capability, installed: [compactionStrategy, pruning], enabled: ['compaction', 'context-pruning'] });
  assert.equal(unsupported.strategy.id, 'compaction');
  assert.equal(unsupported.fallback?.reason, '运行时不支持这个策略');
  const plugin = resolveContextStrategy({ layers: { session: { strategy: 'context-pruning' } }, capability: { ...capability, modes: ['native', 'runtime-plugin'] }, installed: [compactionStrategy, pruning], enabled: ['context-pruning'] });
  assert.equal(plugin.mode, 'runtime-plugin');
  assert.equal(plugin.source, 'session');
  const notEnabled = resolveContextStrategy({ layers: { session: { strategy: 'context-pruning' } }, capability: { ...capability, modes: ['runtime-plugin'] }, installed: [compactionStrategy, pruning], enabled: ['compaction'] });
  assert.equal(notEnabled.fallback?.reason, '项目没启用这个策略');
});

test('L1 能力：每个已支持的运行时都有观察 / 控制，缺口如实标出', () => {
  for (const agent of ['pi', 'grok', 'opencode']) {
    const cap = contextCapabilityOf(agent);
    assert.ok(cap.modes.includes('native'));
    assert.equal(cap.l1.restart, 'runtime');
    assert.equal(cap.l1.memoryTools, 'runtime');
    assert.notEqual(cap.l1.usage, 'missing', '用量至少有估算');
    assert.ok(cap.gaps.length > 0 || cap.l1.compact === 'runtime', `${agent} 缺口要如实标出`);
  }
  const pi = contextCapabilityOf('pi');
  assert.deepEqual([pi.l1.usage, pi.l1.compactionEvents, pi.l1.compact], ['runtime', 'runtime', 'runtime']);
  assert.equal(contextCapabilityOf('opencode').runtime, 'acp');
});

test('估算用量：只算提问 / 回复 / 工具，思考不算；到 70% / 95% 给出 soft / hard', () => {
  const ev = (event: never) => ({ seq: 1 as never, at: 0, event });
  const u = estimateContextUsage([ev({ kind: 'prompt', text: 'hello world' } as never), ev({ kind: 'thinking', delta: 'x'.repeat(10000) } as never), ev({ kind: 'tool_result', name: 'r', ok: true, durationMs: 1, output: '一二三' } as never)], 100);
  assert.equal(u.estimated, true);
  assert.ok(u.usedTokens > 0 && u.usedTokens < 20, `估了 ${u.usedTokens}`);
  assert.equal(estimateContextUsage([ev({ kind: 'text', delta: '字'.repeat(80) } as never)], 100).level, 'soft');
  assert.equal(estimateContextUsage([ev({ kind: 'text', delta: '字'.repeat(96) } as never)], 100).level, 'hard');
});

test('服务：项目选策略要在启用列表里、只能选已安装的；会话只能从项目启用的里选，改了记审计', async () => {
  const { deps } = inMemoryDeps({ now: () => 5 });
  const rows = new Map<string, ContextSetting>();
  const store: ContextSettingsStore = { get: async (k) => rows.get(k) ?? null, set: async (k, v) => void (v ? rows.set(k, v) : rows.delete(k)), list: async (prefix) => [...rows].filter(([k]) => k.startsWith(prefix)).map(([key, setting]) => ({ key, setting })) };
  const audits: AuditEntry[] = [];
  const svc = createContextService({ ...deps, contextSettings: store, audit: { append: async (e) => void audits.push(e), recent: async () => [], query: async () => [] } });
  const project = createProject({ name: 'p', now: 1, teamId: 'T', createdBy: 'alice' });
  assert.ok(project.ok);
  await deps.projects.save(project.value);
  const task = createTask({ projectId: project.value.id, title: 't', goal: '', now: 1 });
  assert.ok(task.ok);
  await deps.tasks.save(task.value);
  const session = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1, createdBy: 'alice' });
  assert.ok(session.ok);
  await deps.sessions.save(session.value);
  await recordEvent(deps, { sessionId: session.value.id, event: { kind: 'prompt', text: '做点事' } });

  assert.equal((await svc.project(null, 'nope')).ok, false);
  assert.equal((await svc.session(null, 'nope')).ok, false);
  const view = await svc.session(null, session.value.id);
  assert.ok(view.ok);
  assert.equal(view.value.strategy.id, 'compaction');
  assert.equal(view.value.source, 'default');
  assert.ok(view.value.usage.usedTokens > 0);

  const bad = await svc.setProject(null, project.value.id, { strategy: 'nope', enabled: ['nope'] });
  assert.equal(bad.ok, false);
  const outside = await svc.setProject(null, project.value.id, { strategy: 'compaction', enabled: [] });
  assert.equal(outside.ok, false);
  const good = await svc.setProject(null, project.value.id, { strategy: 'compaction', enabled: ['compaction'] });
  assert.ok(good.ok);
  assert.equal(good.value.inherited, false);

  assert.equal((await svc.setSession(null, session.value.id, 'trim')).ok, false, '项目没启用');
  const mine = await svc.setSession(null, session.value.id, 'compaction');
  assert.ok(mine.ok);
  assert.equal(mine.value.source, 'session');
  const back = await svc.setSession(null, session.value.id, null);
  assert.ok(back.ok);
  assert.equal(back.value.source, 'project');
  assert.deepEqual(audits.map((a) => a.action), ['context.strategy.set', 'session.context.set', 'session.context.set']);
});

test('用量：运行时报过 context_usage 就用它；压缩成功后从压缩后的数算', () => {
  let seq = 0;
  const ev = (event: unknown) => ({ seq: ++seq as never, at: 0, event: event as never });
  const u = estimateContextUsage([ev({ kind: 'prompt', text: 'hi' }), ev({ kind: 'context_usage', usedTokens: 60000, windowTokens: 200000, percent: 30 })]);
  assert.equal(u.estimated, false);
  assert.equal(u.usedTokens, 60000);
  assert.equal(u.windowTokens, 200000);
  const after = estimateContextUsage([
    ev({ kind: 'context_usage', usedTokens: 190000, windowTokens: 200000, percent: 95 }),
    ev({ kind: 'compaction', phase: 'start', reason: 'manual' }),
    ev({ kind: 'compaction', phase: 'end', reason: 'manual', ok: true, tokensBefore: 190000, tokensAfter: 30000 }),
    ev({ kind: 'context_usage', usedTokens: null, windowTokens: 200000, percent: null })
  ]);
  assert.equal(after.usedTokens, 30000);
  assert.equal(after.windowTokens, 200000);
  assert.deepEqual(after.lastCompaction, { seq: 5, ok: true, tokensBefore: 190000, tokensAfter: 30000 });
});

test('服务：角色层（会话 > 角色 > 项目）和手动压缩（不支持 / 正在回复 / 发出去）', async () => {
  const { deps } = inMemoryDeps({ now: () => 5 });
  const rows = new Map<string, ContextSetting>();
  const store: ContextSettingsStore = { get: async (k) => rows.get(k) ?? null, set: async (k, v) => void (v ? rows.set(k, v) : rows.delete(k)), list: async (prefix) => [...rows].filter(([k]) => k.startsWith(prefix)).map(([key, setting]) => ({ key, setting })) };
  const sent: unknown[] = [];
  const svc = createContextService({
    ...deps,
    contextSettings: store,
    audit: { append: async () => undefined, recent: async () => [], query: async () => [] },
    roleOf: async () => 'coder',
    gateway: { dispatch: async (c) => (sent.push(c), { ok: true, value: undefined }) }
  });
  const project = createProject({ name: 'p', now: 1, teamId: 'T', createdBy: 'alice' });
  assert.ok(project.ok);
  await deps.projects.save(project.value);
  const task = createTask({ projectId: project.value.id, title: 't', goal: '', now: 1 });
  assert.ok(task.ok);
  await deps.tasks.save(task.value);
  const mk = async (agent: string) => {
    const s = deriveSession({ task: task.value, agentId: asAgentId(agent), model: 'm', now: 1, createdBy: 'alice' });
    assert.ok(s.ok);
    await deps.sessions.save(s.value);
    return s.value;
  };
  const pi = await mk('pi');
  assert.equal((await svc.setRole(null, project.value.id, 'bad role!', 'compaction')).ok, false);
  const set = await svc.setRole(null, project.value.id, 'coder', 'compaction');
  assert.ok(set.ok);
  assert.deepEqual(set.value.roles, [{ role: 'coder', strategy: 'compaction' }]);
  const view = await svc.session(null, pi.id);
  assert.ok(view.ok);
  assert.equal(view.value.source, 'role');
  assert.equal(view.value.role, 'coder');
  const cleared = await svc.setRole(null, project.value.id, 'coder', null);
  assert.ok(cleared.ok);
  assert.deepEqual(cleared.value.roles, []);

  const acp = await mk('opencode');
  const no = await svc.compact(null, acp.id);
  assert.equal(no.ok, false);
  await deps.sessions.save({ ...pi, status: 'running' });
  await recordEvent(deps, { sessionId: pi.id, event: { kind: 'prompt', text: '做点事' } });
  const busy = await svc.compact(null, pi.id);
  assert.equal(!busy.ok && busy.error.code, 'conflict');
  await recordEvent(deps, { sessionId: pi.id, event: { kind: 'ended', outcome: 'done' } });
  await recordEvent(deps, { sessionId: pi.id, event: { kind: 'context_usage', usedTokens: 10, windowTokens: 100, percent: 10 } });
  const okay = await svc.compact(null, pi.id, '留下决定');
  assert.ok(okay.ok);
  assert.deepEqual(sent, [{ kind: 'compact', sessionId: pi.id, instructions: '留下决定' }]);
});

test('hub-managed：选了 trim 的会话，transformFor 给出 keep / 引导；compaction（native）不改写', async () => {
  const { deps } = inMemoryDeps({ now: () => 5 });
  const rows = new Map<string, ContextSetting>();
  const store: ContextSettingsStore = { get: async (k) => rows.get(k) ?? null, set: async (k, v) => void (v ? rows.set(k, v) : rows.delete(k)), list: async () => [] };
  const svc = createContextService({ ...deps, contextSettings: store, audit: { append: async () => {}, recent: async () => [], query: async () => [] } });
  const project = createProject({ name: 'p', now: 1, teamId: 'T', createdBy: 'alice' });
  assert.ok(project.ok);
  await deps.projects.save(project.value);
  const task = createTask({ projectId: project.value.id, title: 't', goal: '', now: 1 });
  assert.ok(task.ok);
  await deps.tasks.save(task.value);
  const session = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1, createdBy: 'alice' });
  assert.ok(session.ok);
  await deps.sessions.save(session.value);
  const big = Array.from({ length: 40 }, (_, i) => [{ id: `u${i}`, role: 'user' as const, tokens: 2000, content: null }, { id: `a${i}`, role: 'assistant' as const, tokens: 2000, content: null }]).flat();

  const native = await svc.transformFor(session.value.id, big);
  assert.ok(native.ok);
  assert.equal(native.value.mode, 'native');
  assert.equal(native.value.apply, false);

  assert.ok((await svc.setProject(null, project.value.id, { strategy: 'compaction', enabled: ['compaction', 'trim'] })).ok);
  assert.ok((await svc.setSession(null, session.value.id, 'trim')).ok);
  const trimmed = await svc.transformFor(session.value.id, big);
  assert.ok(trimmed.ok);
  assert.equal(trimmed.value.mode, 'hub-managed');
  assert.equal(trimmed.value.apply, true);
  assert.ok(trimmed.value.keep.length < big.length && trimmed.value.keep.at(-1) === 'a39');
  assert.equal(trimmed.value.guidance.length, 1);
  assert.equal((await svc.transformFor('nope', big)).ok, false);
});
