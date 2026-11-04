import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { available, capabilityMatrix } from '../capability.ts';
import { inMemoryDeps, inMemoryDeliveries } from '../testing/in-memory.ts';
import { ok, err } from '../result.ts';
import { conflict } from '../errors.ts';
import type { TurnCheckpoint } from '../ports/workspace-browser.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { ingestWorkerEvent, promptSessionUseCase } from './conversation.ts';
import { createRewindService, overlaps, type RewindFiles } from './rewind.ts';

const fake: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: capabilityMatrix({ prompt: available, interrupt: available, fork: available, resume: available, tool_calls: available, artifacts: available, structured_events: available, attachments: available }),
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

const native: AgentDescriptor = {
  ...fake,
  capabilities: capabilityMatrix({ prompt: available, interrupt: available, fork: available, resume: available, tool_calls: available, artifacts: available, structured_events: available, attachments: available, branch_at_turn: available })
};

async function world(opts: { native?: boolean } = {}) {
  const w = inMemoryDeps();
  w.agents.push(opts.native ? native : fake);
  const refs = new Map<string, Map<number, string>>();
  const turnRefs = {
    record: async (sessionId: string, promptSeq: number, turnRef: string) => {
      refs.set(sessionId, (refs.get(sessionId) ?? new Map()).set(promptSeq, turnRef));
    },
    list: async (sessionId: string) => refs.get(sessionId) ?? new Map<number, string>()
  };
  let svcRef: ReturnType<typeof createRewindService> | null = null;
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  const sid = session.value.id;
  svcRef = createRewindService({ ...w.deps, files: null as never, turnRefs });
  if (opts.native) await w.deps.sessions.save({ ...(await w.deps.sessions.byId(sid))!, agentSessionRef: 'agent-1' });
  const seqs: number[] = [];
  for (const [text, reply] of [['第一件事', '做完一'], ['第二件事', '做完二']] as const) {
    assert.ok((await promptSessionUseCase(w.deps, { sessionId: sid, text })).ok);
    const at = (await w.deps.sessions.eventsAfter(sid, 0 as never)).filter((e) => e.event.kind === 'prompt' && e.event.text === text).at(-1)!.seq;
    seqs.push(at);
    await ingestWorkerEvent(w.deps, sid, { kind: 'text', delta: reply });
    // 原生标识在 ended 之前到
    if (opts.native) await svcRef!.recordTurnRef(sid, `ref-${text}`);
    await ingestWorkerEvent(w.deps, sid, { kind: 'ended', outcome: 'done' });
  }
  const turns: TurnCheckpoint[] = seqs.map((promptSeq, i) => ({ sessionId: sid, turn: i + 1, promptSeq, before: `b${i + 1}`, after: `a${i + 1}`, files: 1, additions: 1, deletions: 0, startedAt: 0, endedAt: 1 }) as TurnCheckpoint);
  const restores: number[] = [];
  let refuse = false;
  const files: RewindFiles = {
    turnFor: async (_s, seq) => turns.find((t) => t.promptSeq === seq) ?? null,
    turnsOf: async () => turns,
    restoreTurn: async (_s, seq) => {
      if (refuse) return err(conflict('这一轮之后的提交已经推送到远端'));
      restores.push(seq);
      return ok({ safety: 'safe', restored: 2, removed: 1, turn: turns.find((t) => t.promptSeq === seq)!.turn });
    }
  };
  const svc = createRewindService({ ...w.deps, files, turnRefs });
  return { ...w, svc, sid, seqs, restores, refs, files, task: task.value, project: project.value, refuse: () => (refuse = true) };
}

test('从这里重来：只回滚对话 = 从这条消息之前分叉，之前的对话做交接摘要，原消息回填', async () => {
  const w = await world();
  const out = await w.svc.rewind(null, w.sid, w.seqs[1]!, false);
  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(out.value.prompt, '第二件事');
  assert.equal(out.value.files, null);
  assert.deepEqual(out.value.session.origin, { kind: 'fork', fromSessionId: w.sid, atSeq: w.seqs[1]! - 1 });
  const start = w.dispatched.filter((c) => c.kind === 'start_session').at(-1);
  assert.ok(start?.kind === 'start_session' && start.resume === null);
  const brief = w.dispatched.at(-1);
  assert.ok(brief?.kind === 'prompt' && brief.sessionId === out.value.session.id);
  assert.match(brief.text, /第一件事/);
  assert.match(brief.text, /做完一/);
  assert.doesNotMatch(brief.text, /第二件事|做完二/);
  assert.match(brief.text, /文件没有回滚/);
  // 原会话一个字不删，只多一条记号
  const source = await w.deps.sessions.eventsAfter(w.sid, 0 as never);
  assert.ok(source.some((e) => e.event.kind === 'prompt' && e.event.text === '第二件事'));
  assert.ok(source.some((e) => e.event.kind === 'diagnostic' && /重来/.test(e.event.text)));
});

test('从这里重来：第一条消息也能重来（什么都不继承、不发交接）', async () => {
  const w = await world();
  const before = w.dispatched.length;
  const out = await w.svc.rewind(null, w.sid, w.seqs[0]!, false);
  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(out.value.prompt, '第一件事');
  assert.equal(w.dispatched.slice(before).filter((c) => c.kind === 'prompt').length, 0);
});

test('从这里重来：长期工作空间不能连文件回滚，说清原因；不是问话的序号被拒', async () => {
  const w = await world();
  const preview = await w.svc.preview(null, w.sid, w.seqs[1]!);
  assert.ok(preview.ok);
  assert.equal(preview.value.filesAllowed, false);
  assert.match(preview.value.filesBlocked ?? '', /临时工作空间/);
  assert.equal(preview.value.turnsAfter, 1);
  const refused = await w.svc.rewind(null, w.sid, w.seqs[1]!, true);
  assert.ok(!refused.ok && refused.error.code === 'conflict');
  assert.equal(w.restores.length, 0);
  assert.equal((await w.svc.preview(null, w.sid, w.seqs[1]! + 1)).ok, false);
});

test('从这里重来：临时工作空间连文件回滚；共用 / 同目录有会话在跑 / 已推送 都拒绝', async () => {
  const w = await world();
  const session = (await w.deps.sessions.byId(w.sid))!;
  const ws = (await w.deps.workspaces.byId(session.workspaceId!))!;
  await w.deps.workspaces.save({ ...ws, kind: 'temporary', ownerTaskId: w.task.id, isGit: true });
  const preview = await w.svc.preview(null, w.sid, w.seqs[0]!);
  assert.ok(preview.ok && preview.value.filesAllowed, JSON.stringify(preview));
  assert.equal(preview.value.turnsAfter, 2);

  // 同目录另一条会话在跑
  const other = { value: { ...session, id: 'other-session' as never } };
  await w.deps.sessions.save({ ...other.value, workspaceId: ws.id, status: 'running' });
  const busy = await w.svc.preview(null, w.sid, w.seqs[0]!);
  assert.ok(busy.ok && /别的会话正在运行/.test(busy.value.filesBlocked ?? ''));
  await w.deps.sessions.save({ ...other.value, workspaceId: ws.id, status: 'done' });

  const out = await w.svc.rewind(null, w.sid, w.seqs[0]!, true);
  assert.ok(out.ok, JSON.stringify(out));
  assert.deepEqual(w.restores, [w.seqs[0]]);
  assert.equal(out.value.files?.turn, 1);
  const note = (await w.deps.sessions.eventsAfter(w.sid, 0 as never)).at(-1)!.event;
  assert.ok(note.kind === 'diagnostic' && /文件已回滚/.test(note.text));

  // 刚分叉出来的新会话也在这个目录里跑：再回滚文件会被拦
  const blockedByFork = await w.svc.preview(null, w.sid, w.seqs[1]!);
  assert.ok(blockedByFork.ok && /正在运行/.test(blockedByFork.value.filesBlocked ?? ''));
  await w.deps.sessions.save({ ...out.value.session, status: 'done' });
  w.refuse();
  const pushed = await w.svc.rewind(null, w.sid, w.seqs[1]!, true);
  assert.ok(!pushed.ok && /推送/.test(pushed.error.message), JSON.stringify(pushed));

  await w.deps.workspaces.save({ ...ws, kind: 'temporary', ownerTaskId: 'other-task' as never, isGit: true });
  const shared = await w.svc.preview(null, w.sid, w.seqs[0]!);
  assert.ok(shared.ok && /共用/.test(shared.value.filesBlocked ?? ''));
});

test('父子目录算重叠', () => {
  assert.ok(overlaps('/a/b', '/a/b/c'));
  assert.ok(overlaps('/a/b/', '/a/b'));
  assert.ok(!overlaps('/a/b', '/a/bc'));
});

test('原生分叉（ADR 0028）：标识记到对应那一轮；能原生就带 branch 启动、不发摘要，worker 回 native 后只留一条说明', async () => {
  const w = await world({ native: true });
  assert.deepEqual([...(w.refs.get(w.sid) ?? new Map()).entries()], [[w.seqs[0]!, 'ref-第一件事'], [w.seqs[1]!, 'ref-第二件事']]);
  const preview = await w.svc.preview(null, w.sid, w.seqs[1]!);
  assert.ok(preview.ok && preview.value.mode === 'native', JSON.stringify(preview));
  const before = w.dispatched.length;
  const out = await w.svc.rewind(null, w.sid, w.seqs[1]!, false);
  assert.ok(out.ok && out.value.mode === 'native', JSON.stringify(out));
  const sent = w.dispatched.slice(before);
  const start = sent.find((c) => c.kind === 'start_session');
  assert.ok(start?.kind === 'start_session');
  assert.deepEqual(start.branch, { fromAgentSessionRef: 'agent-1', turnRef: 'ref-第二件事', previousTurnRef: 'ref-第一件事' });
  assert.equal(sent.filter((c) => c.kind === 'prompt').length, 0);
  await w.svc.branchResult(out.value.session.id, 'native');
  const events = await w.deps.sessions.eventsAfter(out.value.session.id, 0 as never);
  assert.ok(events.some((e) => e.event.kind === 'diagnostic' && /已原生分叉/.test(e.event.text)));
  assert.equal(w.dispatched.slice(before).filter((c) => c.kind === 'prompt').length, 0);
});

test('原生分叉失败：worker 已退成新开会话，hub 补发交接摘要并说明原因', async () => {
  const w = await world({ native: true });
  const out = await w.svc.rewind(null, w.sid, w.seqs[1]!, false);
  assert.ok(out.ok && out.value.mode === 'native');
  const before = w.dispatched.length;
  await w.svc.branchResult(out.value.session.id, 'failed', 'fork 报错');
  const brief = w.dispatched.slice(before).find((c) => c.kind === 'prompt');
  assert.ok(brief?.kind === 'prompt' && /第一件事/.test(brief.text) && !/第二件事/.test(brief.text));
  const events = await w.deps.sessions.eventsAfter(out.value.session.id, 0 as never);
  assert.ok(events.some((e) => e.event.kind === 'diagnostic' && /原生分叉失败（fork 报错）/.test(e.event.text)));
});

test('不能原生分叉：preview 说清原因，rewind 走摘要并在新会话里提示；第一条消息 mode = none', async () => {
  const w = await world();
  const preview = await w.svc.preview(null, w.sid, w.seqs[1]!);
  assert.ok(preview.ok && preview.value.mode === 'summary' && /摘要交接/.test(preview.value.modeReason ?? ''), JSON.stringify(preview));
  const first = await w.svc.preview(null, w.sid, w.seqs[0]!);
  assert.ok(first.ok && first.value.mode === 'none');
  const out = await w.svc.rewind(null, w.sid, w.seqs[1]!, false);
  assert.ok(out.ok && out.value.mode === 'summary');
  const start = w.dispatched.filter((c) => c.kind === 'start_session').at(-1);
  assert.ok(start?.kind === 'start_session' && start.branch === undefined);
  const events = await w.deps.sessions.eventsAfter(out.value.session.id, 0 as never);
  assert.ok(events.some((e) => e.event.kind === 'diagnostic' && /改用摘要交接/.test(e.event.text)));
});

test('原生分叉：缺上一轮标识（功能上线前的消息）就退回摘要', async () => {
  const w = await world({ native: true });
  w.refs.get(w.sid)!.delete(w.seqs[0]!);
  const preview = await w.svc.preview(null, w.sid, w.seqs[1]!);
  assert.ok(preview.ok && preview.value.mode === 'summary' && /原生标识/.test(preview.value.modeReason ?? ''));
});

test('原生分叉：能力以原会话所在那台机器为准（别的机器上同名 agent 是老版本也不影响）', async () => {
  const w = await world({ native: true });
  const session = (await w.deps.sessions.byId(w.sid))!;
  const agents = w.deps.agents;
  // 「第一台」报的是老版本（不支持），原会话那台支持
  const svc = createRewindService({
    ...w.deps,
    agents: { list: () => agents.list(), descriptor: () => fake, descriptorOn: (workerId, id) => (workerId === session.workerId ? agents.descriptor(id) : null) },
    files: w.files,
    turnRefs: { record: async () => undefined, list: async () => w.refs.get(w.sid) ?? new Map() }
  });
  const preview = await svc.preview(null, w.sid, w.seqs[1]!);
  assert.ok(preview.ok && preview.value.mode === 'native', JSON.stringify(preview));
});

test('原生分叉等结果期间 hub 重启：交接摘要落在送达队列里，新的服务实例照样补发（ADR 0031）', async () => {
  const w = await world({ native: true });
  const deliveries = inMemoryDeliveries();
  const turnRefs = { record: async () => undefined, list: async () => w.refs.get(w.sid) ?? new Map<number, string>() };
  const first = createRewindService({ ...w.deps, deliveries, files: w.files, turnRefs });
  const out = await first.rewind(null, w.sid, w.seqs[1]!, false);
  assert.ok(out.ok && out.value.mode === 'native', JSON.stringify(out));
  assert.equal([...deliveries.rows.values()].filter((d) => d.state === 'held').length, 1);
  // 「重启」：丢掉旧服务，只留数据库
  const second = createRewindService({ ...w.deps, deliveries, files: w.files, turnRefs });
  const before = w.dispatched.length;
  await second.branchResult(out.value.session.id, 'failed', 'fork 报错');
  const brief = w.dispatched.slice(before).find((c) => c.kind === 'prompt');
  assert.ok(brief?.kind === 'prompt' && /第一件事/.test(brief.text));
  assert.equal([...deliveries.rows.values()].filter((d) => d.state === 'held').length, 0);
});
