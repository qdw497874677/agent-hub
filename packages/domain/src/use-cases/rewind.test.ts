import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { available, capabilityMatrix } from '../capability.ts';
import { inMemoryDeps, inMemoryDeliveries } from '../testing/in-memory.ts';
import { ok, err } from '../result.ts';
import { unavailable } from '../errors.ts';
import type { TurnCheckpoint } from '../ports/workspace-browser.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { ingestWorkerEvent, promptSessionUseCase } from './conversation.ts';
import { createRewindService, overlaps, type RewindFiles, type BranchAttempt, type BranchAttemptStore } from './rewind.ts';
import { applyEvent } from '../session.ts';
import { asSessionId } from '../ids.ts';

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

function serialQueue() {
  const tails = new Map<string, Promise<void>>();
  return {
    async run<T>(id: string, work: () => Promise<T>): Promise<T> {
      const previous = tails.get(id) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      tails.set(id, previous.then(() => gate));
      await previous;
      try { return await work(); } finally { release(); }
    }
  };
}

async function world(opts: { native?: boolean } = {}) {
  const w = inMemoryDeps();
  const deliveries = inMemoryDeliveries();
  const attempts = new Map<string, BranchAttempt>();
  const branchAttempts: BranchAttemptStore = {
    async stage(session, attempt) { await w.deps.sessions.save(session); attempts.set(session.id, attempt); },
    async bySession(id) { return attempts.get(id) ?? null; },
    async settle(id, attemptId, workerId, receipt, now) {
      const attempt = attempts.get(id);
      if (!attempt || attempt.id !== attemptId || attempt.workerId !== workerId || attempt.state !== 'pending') return { kind: 'ignored' };
      const { outcome } = receipt;
      const current = (await w.deps.sessions.byId(asSessionId(id)))!;
      const session = receipt.outcome === 'both_failed'
        ? { ...current, status: 'failed' as const, updatedAt: now }
        : { ...current, agentSessionRef: receipt.agentSessionRef, updatedAt: now };
      await w.deps.sessions.save(session);
      attempts.set(id, { ...attempt, state: outcome, updatedAt: now });
      if (outcome !== 'plain') return { kind: 'settled', session, event: null, delivery: null };
      const event = { kind: 'prompt' as const, text: attempt.brief.text, handoff: attempt.brief.stats, promptActor: 'system' as const };
      const next = applyEvent(session, event, now);
      await w.deps.sessions.append(next, event, now);
      const delivery = { id: `branch_brief_${attemptId}`, sessionId: id, seq: next.lastSeq, kind: 'prompt' as const, payload: { text: attempt.brief.text, parts: [] }, state: 'queued' as const, attempt: 0, nextAt: now, lastError: null, createdAt: now, updatedAt: now };
      await deliveries.save(delivery);
      return { kind: 'settled', session: next, event, delivery };
    }
  };
  w.agents.push(opts.native ? native : fake);
  const refs = new Map<string, Map<number, string>>();
  const proofs = new Map<string, Map<number, { turnRef: string; deliveryId: string }>>();
  const turnRefs = {
    record: async (sessionId: string, promptSeq: number, turnRef: string, deliveryId: string) => {
      if (proofs.get(sessionId)?.has(promptSeq)) return;
      refs.set(sessionId, (refs.get(sessionId) ?? new Map()).set(promptSeq, turnRef));
      proofs.set(sessionId, (proofs.get(sessionId) ?? new Map()).set(promptSeq, { turnRef, deliveryId }));
    },
    list: async (sessionId: string) => refs.get(sessionId) ?? new Map<number, string>(),
    listVerified: async (sessionId: string) => proofs.get(sessionId) ?? new Map()
  };
  let svcRef: ReturnType<typeof createRewindService> | null = null;
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  const sid = session.value.id;
  svcRef = createRewindService({ ...w.deps, deliveries, files: null as never, turnRefs });
  if (opts.native) await w.deps.sessions.save({ ...(await w.deps.sessions.byId(sid))!, agentSessionRef: 'agent-1' });
  const seqs: number[] = [];
  for (const [text, reply] of [['第一件事', '做完一'], ['第二件事', '做完二']] as const) {
    assert.ok((await promptSessionUseCase(w.deps, { sessionId: sid, text })).ok);
    const at = (await w.deps.sessions.eventsAfter(sid, 0 as never)).filter((e) => e.event.kind === 'prompt' && e.event.text === text).at(-1)!.seq;
    seqs.push(at);
    await ingestWorkerEvent(w.deps, sid, { kind: 'text', delta: reply });
    // 原生标识在 ended 之前到
    if (opts.native) {
      const id = `delivery-${at}`;
      await deliveries.save({ id, sessionId: sid, seq: at, kind: 'prompt', payload: {}, state: 'sending', attempt: 0, nextAt: null, lastError: null, createdAt: 0, updatedAt: 0 });
      const workerId = (await w.deps.sessions.byId(sid))!.workerId!;
      await svcRef!.recordTurnRef(sid, `ref-${text}`, workerId, id);
      await ingestWorkerEvent(w.deps, sid, { kind: 'ended', outcome: 'done', deliveryId: id });
      await deliveries.finishSending(sid, id, 0);
    } else await ingestWorkerEvent(w.deps, sid, { kind: 'ended', outcome: 'done' });
  }
  const turns: TurnCheckpoint[] = seqs.map((promptSeq, i) => ({ sessionId: sid, turn: i + 1, promptSeq, before: `b${i + 1}`, after: `a${i + 1}`, files: 1, additions: 1, deletions: 0, startedAt: 0, endedAt: 1 }) as TurnCheckpoint);
  const restores: number[] = [];
  const files: RewindFiles = {
    turnFor: async (_s, seq) => turns.find((t) => t.promptSeq === seq) ?? null,
    turnsOf: async () => turns,
    restoreTurn: async (_s, seq) => {
      restores.push(seq);
      return ok({ safety: 'safe', restored: 2, removed: 1, turn: turns.find((t) => t.promptSeq === seq)!.turn });
    }
  };
  const svc = createRewindService({ ...w.deps, files, turnRefs, branchAttemptWriter: branchAttempts, ...(opts.native ? { deliveries } : {}), supportsNativeBranch: () => true });
  return { ...w, svc, sid, seqs, restores, refs, proofs, files, attempts, branchAttempts, deliveries, turnRefs, task: task.value, project: project.value };
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
  assert.match(preview.value.filesBlocked ?? '', /临时工作目录/);
  assert.equal(preview.value.turnsAfter, 1);
  const refused = await w.svc.rewind(null, w.sid, w.seqs[1]!, true);
  assert.ok(!refused.ok && refused.error.code === 'conflict');
  assert.equal(w.restores.length, 0);
  assert.equal((await w.svc.preview(null, w.sid, w.seqs[1]! + 1)).ok, false);
});

test('有精确检查点的普通临时 Git 目录也不能回滚文件，不中断、派生或恢复', async () => {
  for (const status of ['running', 'done'] as const) {
    const w = await world();
    const session = (await w.deps.sessions.byId(w.sid))!;
    const ws = (await w.deps.workspaces.byId(session.workspaceId!))!;
    await w.deps.workspaces.save({ ...ws, kind: 'temporary', ownerTaskId: w.task.id, isGit: true });
    await w.deps.sessions.save({ ...session, status });
    assert.ok(await w.files.turnFor(w.sid, w.seqs[0]!));
    const beforeSource = await w.deps.sessions.byId(w.sid);
    const beforeEvents = await w.deps.sessions.eventsAfter(w.sid, 0 as never);
    const beforeSessions = await w.deps.sessions.listByTask(w.task.id);
    const beforeCommands = [...w.dispatched];
    const preview = await w.svc.preview(null, w.sid, w.seqs[0]!);
    assert.ok(preview.ok);
    assert.equal(preview.value.filesAllowed, false);
    assert.match(preview.value.filesBlocked ?? '', /只回滚对话.*手动/);
    assert.equal(preview.value.turnsAfter, 2);
    const out = await w.svc.rewind(null, w.sid, w.seqs[0]!, true);
    assert.ok(!out.ok && out.error.code === 'conflict');
    assert.equal(out.error.message, preview.value.filesBlocked);
    assert.deepEqual(await w.deps.sessions.byId(w.sid), beforeSource);
    assert.deepEqual(await w.deps.sessions.eventsAfter(w.sid, 0 as never), beforeEvents);
    assert.deepEqual(await w.deps.sessions.listByTask(w.task.id), beforeSessions);
    assert.deepEqual(w.dispatched, beforeCommands);
    assert.deepEqual(w.restores, []);
  }
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
  const attempt = w.attempts.get(out.value.session.id)!;
  assert.equal(start.branchAttemptId, attempt.id);
  await w.svc.branchResult(out.value.session.id, attempt.id, attempt.workerId, { outcome: 'native', agentSessionRef: 'native-child' });
  const events = await w.deps.sessions.eventsAfter(out.value.session.id, 0 as never);
  assert.equal(events.filter((e) => e.event.kind === 'prompt').length, 0);
  assert.equal(w.attempts.get(out.value.session.id)?.state, 'native');
  assert.equal((await w.deps.sessions.byId(out.value.session.id))?.agentSessionRef, 'native-child');
  assert.equal(w.dispatched.slice(before).filter((c) => c.kind === 'prompt').length, 0);
});

test('原生分叉失败：worker 已退成新开会话，hub 补发交接摘要并说明原因', async () => {
  const w = await world({ native: true });
  const out = await w.svc.rewind(null, w.sid, w.seqs[1]!, false);
  assert.ok(out.ok && out.value.mode === 'native');
  const attempt = w.attempts.get(out.value.session.id)!;
  await w.svc.branchResult(out.value.session.id, 'failed', 'fork 报错'); // legacy cannot settle
  const receipt = { outcome: 'plain', agentSessionRef: 'plain-child' } as const;
  await w.svc.branchResult(out.value.session.id, attempt.id, 'wrong-worker', receipt);
  assert.equal(w.attempts.get(out.value.session.id)?.state, 'pending');
  await w.svc.branchResult(out.value.session.id, attempt.id, attempt.workerId, receipt);
  await w.svc.branchResult(out.value.session.id, attempt.id, attempt.workerId, receipt);
  const events = await w.deps.sessions.eventsAfter(out.value.session.id, 0 as never);
  const prompts = events.filter((e) => e.event.kind === 'prompt');
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0]!.event.kind === 'prompt' && /第一件事/.test(prompts[0]!.event.text));
  assert.equal((await w.deliveries.pendingFor(out.value.session.id)).length, 1);
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
  w.proofs.get(w.sid)!.delete(w.seqs[0]!);
  const preview = await w.svc.preview(null, w.sid, w.seqs[1]!);
  assert.ok(preview.ok && preview.value.mode === 'summary' && /原生标识/.test(preview.value.modeReason ?? ''));
});

test('invalid source or verified turn refs always choose summary before branch staging', async () => {
  const invalidRefs = [null, '', ' \t', 'pending', ' pending ', ' PeNdInG ', '界'.repeat(171)] as const;
  for (const location of ['source', 'current', 'previous'] as const) {
    for (const ref of invalidRefs) {
      const w = await world({ native: true });
      if (location === 'source') {
        await w.deps.sessions.save({ ...(await w.deps.sessions.byId(w.sid))!, agentSessionRef: ref });
      } else {
        const seq = w.seqs[location === 'current' ? 1 : 0]!;
        const proof = w.proofs.get(w.sid)!.get(seq)!;
        w.proofs.get(w.sid)!.set(seq, { ...proof, turnRef: ref as string });
      }
      const preview = await w.svc.preview(null, w.sid, w.seqs[1]!);
      assert.ok(preview.ok && preview.value.mode === 'summary', `${location}: ${ref}`);
      const result = await w.svc.rewind(null, w.sid, w.seqs[1]!, false);
      assert.ok(result.ok && result.value.mode === 'summary', `${location}: ${ref}`);
      assert.equal(w.attempts.size, 0);
      const start = w.dispatched.filter((command) => command.kind === 'start_session').at(-1);
      assert.ok(start?.kind === 'start_session' && !start.branch);
    }
  }
});

test('invalid native turn refs never acquire delivery proof; 512 UTF-8 bytes are valid', async () => {
  const w = await world({ native: true });
  const seq = w.seqs[1]!;
  const worker = (await w.deps.sessions.byId(w.sid))!.workerId!;
  w.proofs.get(w.sid)!.delete(seq);
  w.refs.get(w.sid)!.delete(seq);
  for (const ref of ['', ' \t', 'pending', ' pending ', ' PeNdInG ', '界'.repeat(171)]) {
    await w.svc.recordTurnRef(w.sid, ref, worker, `delivery-${seq}`);
    assert.equal(w.proofs.get(w.sid)!.has(seq), false);
  }
  const valid = '界'.repeat(170) + 'ab';
  await w.svc.recordTurnRef(w.sid, valid, worker, `delivery-${seq}`);
  assert.equal(w.proofs.get(w.sid)!.get(seq)?.turnRef, valid);
  const preview = await w.svc.preview(null, w.sid, seq);
  assert.ok(preview.ok && preview.value.mode === 'native');
});

test('native refs require exact worker, prompt delivery and ended evidence; delayed B never lands on C', async () => {
  const w = await world({ native: true });
  const [a, b] = w.seqs as [number, number];
  const worker = (await w.deps.sessions.byId(w.sid))!.workerId!;
  const bId = `delivery-${b}`;
  w.refs.get(w.sid)!.set(b, 'legacy-B');
  w.proofs.get(w.sid)!.delete(b);
  assert.ok((await w.svc.preview(null, w.sid, b)).ok);
  const legacyPreview = await w.svc.preview(null, w.sid, b);
  assert.ok(legacyPreview.ok && legacyPreview.value.mode === 'summary');
  assert.ok((await promptSessionUseCase(w.deps, { sessionId: w.sid, text: 'C' })).ok);
  const c = (await w.deps.sessions.eventsAfter(w.sid, 0 as never)).find((e) => e.event.kind === 'prompt' && e.event.text === 'C')!.seq;
  const cId = `delivery-${c}`;
  await w.deliveries.save({ id: cId, sessionId: w.sid, seq: c, kind: 'prompt', payload: {}, state: 'sending', attempt: 0, nextAt: null, lastError: null, createdAt: 0, updatedAt: 0 });
  await w.svc.recordTurnRef(w.sid, 'unkeyed');
  await w.svc.recordTurnRef(w.sid, 'wrong-worker', 'wrong', bId);
  await w.svc.recordTurnRef(w.sid, 'wrong-delivery', worker, 'missing');
  await w.deliveries.save({ ...w.deliveries.rows.get(bId)!, id: 'wrong-session', sessionId: 'other' });
  await w.deliveries.save({ ...w.deliveries.rows.get(bId)!, id: 'wrong-kind', kind: 'handoff_brief' });
  await w.deliveries.save({ ...w.deliveries.rows.get(bId)!, id: 'wrong-seq', seq: b + 1, state: 'sending' });
  await w.deliveries.save({ ...w.deliveries.rows.get(bId)!, id: 'no-ended' });
  await w.deliveries.save({ ...w.deliveries.rows.get(bId)!, id: 'queued', state: 'queued' });
  await w.deliveries.save({ ...w.deliveries.rows.get(bId)!, id: 'zero', seq: 0, state: 'sending' });
  for (const id of ['wrong-session', 'wrong-kind', 'wrong-seq', 'no-ended', 'queued', 'zero']) await w.svc.recordTurnRef(w.sid, id, worker, id);
  assert.equal(w.refs.get(w.sid)!.get(b), 'legacy-B');
  assert.equal(w.refs.get(w.sid)!.get(c), undefined);
  await w.svc.recordTurnRef(w.sid, 'verified-B', worker, bId);
  await w.svc.recordTurnRef(w.sid, 'conflicting-B', worker, bId);
  await w.svc.recordTurnRef(w.sid, 'verified-C', worker, cId);
  assert.equal(w.refs.get(w.sid)!.get(a), 'ref-第一件事');
  assert.equal(w.refs.get(w.sid)!.get(b), 'verified-B');
  assert.equal(w.refs.get(w.sid)!.get(c), 'verified-C');
  const preview = await w.svc.preview(null, w.sid, c);
  assert.ok(preview.ok && preview.value.mode === 'native');
  w.proofs.get(w.sid)!.set(b, { turnRef: 'forged', deliveryId: cId });
  const forged = await w.svc.preview(null, w.sid, c);
  assert.ok(forged.ok && forged.value.mode === 'summary');
  w.proofs.get(w.sid)!.delete(b);
  await w.deliveries.save({ ...w.deliveries.rows.get(bId)!, state: 'sending' });
  await w.svc.recordTurnRef(w.sid, 'still-sending-B', worker, bId);
  assert.equal(w.refs.get(w.sid)!.get(b), 'still-sending-B');
  assert.equal(w.refs.get(w.sid)!.get(c), 'verified-C');
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
    turnRefs: w.turnRefs,
    branchAttemptWriter: w.branchAttempts, deliveries: w.deliveries, supportsNativeBranch: () => true
  });
  const preview = await svc.preview(null, w.sid, w.seqs[1]!);
  assert.ok(preview.ok && preview.value.mode === 'native', JSON.stringify(preview));
});

test('原生分叉只接受匹配的明确结果，新服务实例可继续结算', async () => {
  const w = await world({ native: true });
  const first = w.svc;
  const out = await first.rewind(null, w.sid, w.seqs[1]!, false);
  assert.ok(out.ok && out.value.mode === 'native', JSON.stringify(out));
  const second = createRewindService({ ...w.deps, deliveries: w.deliveries, files: w.files, turnRefs: w.turnRefs, branchAttemptWriter: w.branchAttempts, supportsNativeBranch: () => true });
  const attempt = w.attempts.get(out.value.session.id)!;
  await second.branchResult(out.value.session.id, attempt.id, attempt.workerId, { outcome: 'both_failed' });
  await second.branchResult(out.value.session.id, attempt.id, attempt.workerId, { outcome: 'plain', agentSessionRef: 'late-child' });
  assert.equal(w.attempts.get(out.value.session.id)?.state, 'both_failed');
  assert.equal((await w.deliveries.pendingFor(out.value.session.id)).length, 0);
});

test('unsupported worker uses summary before dispatch', async () => {
  const w = await world({ native: true });
  const service = createRewindService({ ...w.deps, files: w.files, turnRefs: w.turnRefs, branchAttemptWriter: w.branchAttempts, deliveries: w.deliveries, supportsNativeBranch: () => false });
  const out = await service.rewind(null, w.sid, w.seqs[1]!, false);
  assert.ok(out.ok && out.value.mode === 'summary');
  const command = w.dispatched.filter((c) => c.kind === 'start_session').at(-1);
  assert.ok(command?.kind === 'start_session' && !command.branch);
});

test('attempt and child are available before dispatch, including an early result', async () => {
  const w = await world({ native: true });
  const dispatch = w.deps.gateway.dispatch;
  w.deps.gateway.dispatch = async (command) => {
    if (command.kind === 'start_session' && command.branch) {
      const staged = await w.branchAttempts.bySession(command.sessionId);
      assert.ok(staged && staged.id === command.branchAttemptId);
      assert.ok(await w.deps.sessions.byId(command.sessionId));
      await w.svc.branchResult(command.sessionId, staged.id, staged.workerId, { outcome: 'plain', agentSessionRef: 'early-child' });
    }
    return dispatch(command);
  };
  const result = await w.svc.rewind(null, w.sid, w.seqs[1]!, false);
  assert.ok(result.ok);
  assert.equal(w.attempts.get(result.value.session.id)?.state, 'plain');
  assert.equal((await w.deliveries.pendingFor(result.value.session.id)).length, 1);
});

test('rewind diagnostics serialize with worker events for child and source', async () => {
  for (const target of ['child', 'source'] as const) {
    const w = await world();
    const deps = { ...w.deps, queue: serialQueue() };
    const svc = createRewindService({ ...deps, files: w.files, turnRefs: w.turnRefs });
    const append = w.deps.sessions.append.bind(w.deps.sessions);
    let entered!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let targetId = '';
    w.deps.sessions.append = async (session, event, now) => {
      if (event.kind === 'diagnostic' && ((target === 'source' && session.id === w.sid) || (target === 'child' && session.id !== w.sid))) {
        targetId = session.id;
        entered();
        await gate;
      }
      return append(session, event, now);
    };
    const published: number[] = [];
    const publish = w.deps.stream.publish.bind(w.deps.stream);
    w.deps.stream.publish = (entry) => { if (entry.sessionId === targetId) published.push(entry.seq); publish(entry); };
    const rewind = svc.rewind(null, w.sid, w.seqs[1]!, false);
    await blocked;
    const worker = ingestWorkerEvent(deps, asSessionId(targetId), { kind: 'text', delta: 'concurrent' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    assert.ok((await rewind).ok);
    await worker;
    const events = await w.deps.sessions.eventsAfter(asSessionId(targetId), 0 as never);
    const diagnostic = events.findIndex((e) => e.event.kind === 'diagnostic' && (target === 'source' ? /重来/.test(e.event.text) : /改用摘要交接/.test(e.event.text)));
    const concurrent = events.findIndex((e) => e.event.kind === 'text' && e.event.delta === 'concurrent');
    assert.ok(diagnostic >= 0 && concurrent > diagnostic);
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
    assert.deepEqual(published, [...published].sort((a, b) => a - b));
  }
});

test('branch brief publication precedes later queued events and wake runs outside child lock', async () => {
  const w = await world({ native: true });
  const out = await w.svc.rewind(null, w.sid, w.seqs[1]!, false);
  assert.ok(out.ok);
  const id = out.value.session.id;
  const attempt = w.attempts.get(id)!;
  const deps = { ...w.deps, queue: serialQueue() };
  const published: number[] = [];
  const publish = w.deps.stream.publish.bind(w.deps.stream);
  w.deps.stream.publish = (entry) => { if (entry.sessionId === id) published.push(entry.seq); publish(entry); };
  let woke = false;
  const svc = createRewindService({ ...deps, files: w.files, turnRefs: w.turnRefs, deliveries: w.deliveries, branchAttemptWriter: w.branchAttempts, onBranchBriefReady: async () => { await deps.queue.run(id, async () => { woke = true; }); } });
  const result = svc.branchResult(id, attempt.id, attempt.workerId, { outcome: 'plain', agentSessionRef: 'child-ref' });
  const worker = ingestWorkerEvent(deps, id, { kind: 'text', delta: 'later' });
  await Promise.all([result, worker]);
  assert.ok(woke);
  assert.deepEqual(published, [1, 2]);
  assert.deepEqual((await w.deps.sessions.eventsAfter(id, 0 as never)).map((e) => e.seq), [1, 2]);
});

test('uncertain native dispatch does not mark child failed or release its attempt', async () => {
  const w = await world({ native: true });
  w.deps.gateway.dispatch = async (command) => command.kind === 'start_session' && command.branch ? err(unavailable('disconnected')) : ok(undefined);
  const result = await w.svc.rewind(null, w.sid, w.seqs[1]!, false);
  assert.equal(result.ok, false);
  const staged = [...w.attempts.values()][0]!;
  assert.equal(staged.state, 'pending');
  assert.equal((await w.deps.sessions.byId(asSessionId(staged.sessionId)))?.status, 'running');
  assert.equal((await w.deliveries.pendingFor(staged.sessionId)).length, 0);
});

test('从这里重来：开会话失败则新会话是 failed，且不托管', async () => {
  const w = await world();
  const liveBefore = w.deps.hosting.live.size;
  w.deps.gateway.dispatch = async (command) => {
    if (command.kind === 'start_session' && command.sessionId !== w.sid) return err(unavailable('没有 worker'));
    return ok(undefined);
  };
  const out = await w.svc.rewind(null, w.sid, w.seqs[1]!, false);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.error.message, '没有 worker');
  const created = (await w.deps.sessions.listAll()).find((session) => session.id !== w.sid);
  assert.equal(created?.status, 'failed');
  assert.equal(w.deps.hosting.live.has(created!.id), false);
  assert.equal(w.deps.hosting.live.size, liveBefore);
});
