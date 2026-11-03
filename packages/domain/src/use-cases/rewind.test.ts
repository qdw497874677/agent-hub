import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { available, capabilityMatrix } from '../capability.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
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

async function world() {
  const w = inMemoryDeps();
  w.agents.push(fake);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  const sid = session.value.id;
  const seqs: number[] = [];
  for (const [text, reply] of [['第一件事', '做完一'], ['第二件事', '做完二']] as const) {
    assert.ok((await promptSessionUseCase(w.deps, { sessionId: sid, text })).ok);
    const at = (await w.deps.sessions.eventsAfter(sid, 0 as never)).filter((e) => e.event.kind === 'prompt' && e.event.text === text).at(-1)!.seq;
    seqs.push(at);
    await ingestWorkerEvent(w.deps, sid, { kind: 'text', delta: reply });
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
  const svc = createRewindService({ ...w.deps, files });
  return { ...w, svc, sid, seqs, restores, task: task.value, project: project.value, refuse: () => (refuse = true) };
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
