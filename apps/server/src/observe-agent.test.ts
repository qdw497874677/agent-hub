import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, type ObserveTrace } from '@agent-hub/observe';
import type { AccessPolicy, Project, Session, Subject } from '@agent-hub/domain';
import {
  AGENT_SCAN,
  createAgentObserveReader,
  type AgentTurnEnd,
  type AgentTurnRecord
} from './observe-agent.ts';

const NOW = 1_700_000_000_000;

const projectOf = (id: string, over: Partial<Project> = {}): Project =>
  ({
    id,
    name: id,
    teamId: 't1',
    createdBy: 'u1',
    members: [],
    deletedAt: null,
    ...over
  }) as unknown as Project;

const sessionOf = (over: Record<string, unknown> = {}): Session =>
  ({
    id: 's1',
    taskId: null,
    originProjectId: 'p1',
    status: 'done',
    model: 'test-model',
    createdBy: 'u1',
    ...over
  }) as unknown as Session;

const record = (over: Partial<AgentTurnRecord> = {}): AgentTurnRecord => ({
  id: 'd1',
  sessionId: 's1',
  projectId: 'p1',
  seq: 1,
  state: 'delivered',
  attempt: 1,
  createdAt: NOW,
  updatedAt: NOW + 1_000,
  ...over
});

const policy: AccessPolicy = {
  context: async () => ({ hubTeamId: 't1', settings: { membersCanAddMachines: true } }),
  worker: async () => ({ teamId: 't1' })
};

const subject = (over: Record<string, unknown> = {}): Subject =>
  ({
    user: {
      id: 'u1',
      email: 'u1@example.com',
      displayName: 'U1',
      role: 'member',
      passwordHash: null,
      emailVerifiedAt: NOW,
      disabledAt: null,
      createdAt: NOW,
      teamId: 't1',
      clusterAdmin: false,
      deletedAt: null,
      ...over
    },
    loginId: 'l1'
  }) as unknown as Subject;

const query = (over: Partial<{ since: number; source: string | null; projectId: string | null; needsLook: boolean; limit: number }> = {}) => ({
  since: 0,
  source: 'agent' as string | null,
  projectId: null as string | null,
  needsLook: false,
  limit: 50,
  ...over
});

interface WorldSeed {
  readonly records?: readonly AgentTurnRecord[];
  readonly ends?: Readonly<Record<string, AgentTurnEnd>>;
  readonly projects?: readonly Project[];
  readonly sessions?: readonly Session[];
  readonly tasks?: readonly { readonly id: string; readonly projectId: string }[];
}

function world(seed: WorldSeed = {}) {
  const records = seed.records ?? [record()];
  const ends = seed.ends ?? {};
  const projects = seed.projects ?? [projectOf('p1')];
  const sessions = seed.sessions ?? [sessionOf()];
  const tasks = seed.tasks ?? [];
  const calls = {
    list: [] as { projectIds: readonly string[]; since: number; limit: number }[],
    byId: [] as string[],
    ended: [] as { sessionId: string; deliveryId: string; afterSeq: number }[]
  };
  const reader = createAgentObserveReader({
    projects: {
      list: async () => [...projects],
      byId: async (id) => projects.find((project) => project.id === id) ?? null
    },
    sessions: {
      byId: async (id) => sessions.find((session) => session.id === id) ?? null
    },
    tasks: {
      byId: async (id) => (tasks.find((task) => task.id === id) ?? null) as never
    },
    records: {
      list: async (input) => {
        calls.list.push(input);
        return records
          .filter((row) => input.projectIds.includes(row.projectId) && row.createdAt >= input.since)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, input.limit);
      },
      byId: async (id) => {
        calls.byId.push(id);
        return records.find((row) => row.id === id) ?? null;
      },
      ended: async (sessionId, deliveryId, afterSeq) => {
        calls.ended.push({ sessionId, deliveryId, afterSeq });
        return ends[deliveryId] ?? null;
      }
    },
    policy
  });
  return { reader, calls, records, projects, sessions, tasks };
}

const endNode = (trace: ObserveTrace | null) => trace?.nodes.find((node) => node.id.startsWith('end:'));
const sinkNode = (trace: ObserveTrace | null) => trace?.nodes.find((node) => node.id.startsWith('sink:'));
const headNode = (trace: ObserveTrace | null) => trace?.nodes.find((node) => node.id.startsWith('turn:'));

test('exact ended 只通过 deliveryId 关联，并给出准确结束时间', async () => {
  const { reader, calls } = world({
    ends: { d1: { seq: 12, at: NOW + 5_000, outcome: 'done', unknownOutcome: false } }
  });
  const trace = await reader.get('d1', subject());
  assert.equal(trace?.id, 'agent:d1');
  assert.equal(trace?.headId, 'turn:d1');
  assert.equal(trace?.title, 'Agent 回合');

  const head = headNode(trace);
  assert.equal(head?.kind, 'turn');
  assert.deepEqual(head?.links, [{ to: 'end:d1', label: 'deliveryId 对得上的结束' }]);

  const end = endNode(trace);
  assert.equal(end?.kind, 'turn_end');
  assert.equal(end?.state, 'done');
  assert.equal(end?.stateLabel, '完成');
  assert.equal(end?.endedAt, NOW + 5_000);
  assert.equal(end?.durationMs, null, '没有准确开始时间就不给耗时');
  assert.deepEqual(calls.ended, [{ sessionId: 's1', deliveryId: 'd1', afterSeq: 1 }]);

  const tree = buildTree(trace!);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0]?.links[0]?.label, 'deliveryId 对得上的结束');
  assert.equal(tree.roots[0]?.links[0]?.branch.node.state, 'done');
});

test('unknown outcome 显示结果未知，不当作成功或失败', async () => {
  const { reader } = world({
    ends: { d1: { seq: 2, at: NOW + 1_000, outcome: 'done', unknownOutcome: true } }
  });
  const end = endNode(await reader.get('d1', subject()));
  assert.equal(end?.state, 'unknown');
  assert.equal(end?.stateLabel, '结果未知');
  assert.ok(end?.attrs.some((attr) => attr.key === '说明' && attr.value.includes('未知')));
});

test('legacy delivered 没有 exact ended 时结果是未记录，而不是推测成功', async () => {
  const { reader } = world({ records: [record({ state: 'delivered' })] });
  const trace = await reader.get('d1', subject());
  assert.equal(endNode(trace), undefined);
  assert.deepEqual(headNode(trace)?.links, []);
  const sink = sinkNode(trace);
  assert.equal(sink?.stateLabel, null);
  assert.deepEqual(sink?.attrs, [{ key: '说明', value: '未记录' }]);

  const tree = buildTree(trace!);
  assert.equal(tree.unrecorded.length, 1);
});

test('sending / queued / held 的当前状态与结果分开表达', async () => {
  const sending = world({ records: [record({ state: 'sending' })] });
  const sendingTrace = await sending.reader.get('d1', subject());
  assert.equal(sinkNode(sendingTrace), undefined);
  assert.equal(headNode(sendingTrace)?.attrs.find((attr) => attr.key === '结果')?.value, '发送中，等待确认');
  assert.equal(headNode(sendingTrace)?.state, 'sending');
  assert.equal(buildTree(sendingTrace!).unrecorded.length, 0);

  const queued = world({ records: [record({ state: 'queued' })] });
  const queuedTrace = await queued.reader.get('d1', subject());
  assert.equal(headNode(queuedTrace)?.stateLabel, '排队');
  assert.equal(headNode(queuedTrace)?.attrs.find((attr) => attr.key === '结果')?.value, '排队中，尚无结果');
  assert.equal(buildTree(queuedTrace!).unrecorded.length, 0);

  const held = world({
    records: [record({ id: 'h1', seq: 0, state: 'held' })],
    ends: { h1: { seq: 99, at: NOW + 9_000, outcome: 'done', unknownOutcome: false } }
  });
  const heldTrace = await held.reader.get('h1', subject());
  assert.equal(held.calls.ended.length, 0, 'seq 0 的交接简报不查 ended');
  assert.equal(endNode(heldTrace), undefined);
  assert.equal(headNode(heldTrace)?.attrs.find((attr) => attr.key === '结果')?.value, '挂起，尚无精确结果');
  assert.equal(buildTree(heldTrace!).unrecorded.length, 0);
});

test('迟到的 queued B 不会被同一会话里 A 的 ended 影响', async () => {
  const { reader, calls } = world({
    records: [record({ id: 'a', seq: 1, state: 'delivered' }), record({ id: 'b', seq: 2, state: 'queued', createdAt: NOW + 10 })],
    ends: { a: { seq: 3, at: NOW + 1_000, outcome: 'done', unknownOutcome: false } }
  });
  const a = await reader.get('a', subject());
  assert.equal(endNode(a)?.state, 'done');
  const b = await reader.get('b', subject());
  assert.equal(endNode(b), undefined);
  assert.deepEqual(headNode(b)?.links, []);
  assert.equal(headNode(b)?.attrs.find((attr) => attr.key === '结果')?.value, '排队中，尚无结果');
  assert.deepEqual(calls.ended[1], { sessionId: 's1', deliveryId: 'b', afterSeq: 2 });
});

test('list 先按可读项目过滤，再按行重验 session.read', async () => {
  const visibleProject = projectOf('p1', { createdBy: 'u1' });
  const otherProject = projectOf('p2', { createdBy: 'u2' });
  const { reader, calls } = world({
    projects: [visibleProject, otherProject],
    sessions: [
      sessionOf({ id: 's1', originProjectId: 'p1', createdBy: 'u1' }),
      sessionOf({ id: 's2', originProjectId: 'p2', createdBy: 'u2' }),
      sessionOf({ id: 's3', originProjectId: 'p1', createdBy: 'u2' })
    ],
    records: [
      record({ id: 'd1', sessionId: 's1', projectId: 'p1' }),
      record({ id: 'd2', sessionId: 's2', projectId: 'p2', createdAt: NOW + 1 }),
      record({ id: 'd3', sessionId: 's3', projectId: 'p1', createdAt: NOW + 2 })
    ]
  });
  const listed = await reader.list(query(), subject());
  assert.deepEqual(listed.items.map((item) => item.id), ['agent:d1']);
  assert.deepEqual(calls.list[0]?.projectIds, ['p1']);
  for (const item of listed.items) {
    assert.equal(item.title, 'Agent 回合');
    assert.equal(item.source, 'agent');
    assert.equal(item.nativeState, 'delivered');
    assert.equal(item.nativeStateLabel, '已送达');
  }

  // 显式项目过滤：不可读的项目直接空，不去摸存储。
  const explicit = await reader.list(query({ projectId: 'p2' }), subject());
  assert.deepEqual(explicit.items, []);
  assert.equal(calls.list.length, 1);

  // 项目可读但会话不可读：列表不出现，get 与不存在一样返回 null，不泄露属性。
  assert.equal(await reader.get('d3', subject()), null);
  assert.equal(await reader.get('missing', subject()), null);

  const tree = buildTree((await reader.get('d1', subject()))!);
  assert.equal(tree.roots[0]?.node.attrs.find((attr) => attr.key === '项目')?.value, 'p1');
  assert.equal(tree.roots[0]?.node.attrs.find((attr) => attr.key === '会话')?.value, 's1');
});

test('匿名不查项目、不查存储；source 不匹配时也不做多余工作', async () => {
  const { reader, calls } = world();
  const anonymous = await reader.list(query(), null);
  assert.deepEqual(anonymous, { truncated: false, items: [] });
  assert.equal(calls.list.length, 0);
  assert.equal(await reader.get('d1', {}), null);
  assert.equal(calls.byId.length, 0);

  const otherSource = await reader.list(query({ source: 'connector' }), subject());
  assert.deepEqual(otherSource.items, []);
  assert.equal(calls.list.length, 0);
});

test('任务会话用任务的项目并校验 origin；冲突 / 缺 origin 都失败关闭', async () => {
  const tasks = [{ id: 't1', projectId: 'p1' }];

  const ok = world({
    tasks,
    sessions: [sessionOf({ taskId: 't1', originProjectId: 'p1' })],
    records: [record({ id: 'd1' })]
  });
  assert.deepEqual((await ok.reader.list(query(), subject())).items.map((item) => item.id), ['agent:d1']);

  const conflict = world({
    tasks,
    sessions: [sessionOf({ taskId: 't1', originProjectId: 'p2' })],
    records: [record({ id: 'd1' })]
  });
  assert.deepEqual((await conflict.reader.list(query(), subject())).items, []);
  assert.equal(await conflict.reader.get('d1', subject()), null);

  const noOrigin = world({
    sessions: [sessionOf({ taskId: null, originProjectId: null })],
    records: [record({ id: 'd1' })]
  });
  assert.deepEqual((await noOrigin.reader.list(query(), subject())).items, []);
  assert.equal(await noOrigin.reader.get('d1', subject()), null);
});

test('扫描上限 500（多取一条判 truncated），与单次 limit 截断分开', async () => {
  const records = Array.from({ length: AGENT_SCAN + 1 }, (_, index) =>
    record({ id: `d${index}`, seq: index + 1, createdAt: NOW + index })
  );
  const { reader, calls } = world({ records });
  const listed = await reader.list(query({ limit: 1_000 }), subject());
  assert.equal(calls.list[0]?.limit, AGENT_SCAN + 1);
  assert.equal(listed.scanLimit, AGENT_SCAN);
  assert.equal(listed.items.length, AGENT_SCAN);
  assert.equal(listed.truncated, true);

  const small = world({
    records: [record({ id: 'd1' }), record({ id: 'd2', createdAt: NOW + 1 }), record({ id: 'd3', createdAt: NOW + 2 })]
  });
  const limited = await small.reader.list(query({ limit: 2 }), subject());
  assert.equal(limited.items.length, 2);
  assert.equal(limited.truncated, true);
});

test('未送达标 gap；needsLook 不把已送达的正常回合算进来', async () => {
  const { reader } = world({
    records: [
      record({ id: 'd1', state: 'delivered' }),
      record({ id: 'd2', state: 'undelivered', createdAt: NOW + 1 })
    ],
    ends: { d1: { seq: 2, at: NOW + 100, outcome: 'done', unknownOutcome: false } }
  });
  const all = await reader.list(query(), subject());
  assert.equal(all.items.find((item) => item.id === 'agent:d2')?.gap, '未送达');
  assert.equal(all.items.find((item) => item.id === 'agent:d1')?.gap, null);

  const needsLook = await reader.list(query({ needsLook: true }), subject());
  assert.deepEqual(needsLook.items.map((item) => item.id), ['agent:d2']);
});

test('原始 payload / 错误正文 / 工具参数不会出现在响应里', async () => {
  const raw = {
    ...record(),
    payload: 'SECRET PROMPT',
    lastError: 'SECRET ERROR',
    toolArgs: 'SECRET ARGS'
  } as unknown as AgentTurnRecord;
  const { reader } = world({ records: [raw] });
  const listed = JSON.stringify(await reader.list(query(), subject()));
  const trace = JSON.stringify(await reader.get('d1', subject()));
  for (const output of [listed, trace]) {
    assert.equal(output.includes('SECRET'), false);
  }
});

test('不认识的状态 / 结束记录先验证再打标签', async () => {
  const badState = { ...record({ id: 'bad' }), state: 'weird' } as unknown as AgentTurnRecord;
  const { reader } = world({
    records: [record({ id: 'd1' }), badState],
    ends: { d1: { seq: 2, at: NOW, outcome: 'exploded', unknownOutcome: false } as unknown as AgentTurnEnd }
  });
  assert.deepEqual((await reader.list(query(), subject())).items.map((item) => item.id), ['agent:d1']);
  assert.equal(await reader.get('bad', subject()), null);

  const end = endNode(await reader.get('d1', subject()));
  assert.equal(end?.state, 'unknown');
  assert.equal(end?.stateLabel, '结果未知');
});

test('删除的项目和不可读的项目不会出现在列表里', async () => {
  const { reader } = world({ projects: [projectOf('p1', { deletedAt: NOW })] });
  const listed = await reader.list(query(), subject());
  assert.deepEqual(listed.items, []);
});

test('needsLook 根据精确结果识别失败、中断、未知和已送达缺环，保持顺序并独立于当前状态', async () => {
  const states = [
    ['failed', 'delivered'], ['interrupted', 'sending'], ['unknown', 'queued'],
    ['legacy', 'delivered'], ['undelivered', 'undelivered'], ['done', 'delivered'],
    ['stopped', 'delivered'], ['pending', 'sending']
  ] as const;
  const records = states.map(([id, state], i) => record({ id, state, createdAt: NOW + states.length - i }));
  const result = (outcome: AgentTurnEnd['outcome'], unknownOutcome = false): AgentTurnEnd => ({ seq: 2, at: NOW, outcome, unknownOutcome });
  const { reader } = world({ records, ends: {
    failed: result('failed'), interrupted: result('interrupted'), unknown: result('done', true),
    done: result('done'), stopped: result('stopped')
  } });
  const list = await reader.list(query({ needsLook: true }), subject());
  assert.deepEqual(list.items.map((item) => [item.id, item.gap]), [
    ['agent:failed', '回合失败'], ['agent:interrupted', '回合中断'], ['agent:unknown', '结果未知'],
    ['agent:legacy', '未记录精确结果'], ['agent:undelivered', '未送达']
  ]);
  const trace = await reader.get('interrupted', subject());
  assert.equal(headNode(trace)?.state, 'sending');
  assert.equal(endNode(trace)?.state, 'interrupted');
  assert.equal(sinkNode(trace), undefined);
});

test('回执必须严格晚于 prompt seq，且时间和结果字段有效', async () => {
  const invalid = [
    { seq: 1, at: NOW, outcome: 'done', unknownOutcome: false },
    { seq: 0, at: NOW, outcome: 'done', unknownOutcome: false },
    { seq: 2, at: NaN, outcome: 'done', unknownOutcome: false },
    { seq: 2, at: -1, outcome: 'done', unknownOutcome: false },
    { seq: 2, at: NOW, outcome: 'done', unknownOutcome: 'false' }
  ];
  for (const end of invalid) {
    const { reader } = world({ ends: { d1: end as AgentTurnEnd } });
    const trace = await reader.get('d1', subject());
    assert.equal(endNode(trace), undefined);
    assert.equal(buildTree(trace!).unrecorded.length, 1);
    assert.equal((await reader.list(query({ needsLook: true }), subject())).items[0]?.gap, '未记录精确结果');
  }
});

test('明确送达状态没有精确回执时显示根节点属性而不是未记录', async () => {
  for (const state of ['queued', 'sending', 'held', 'cancelled', 'undelivered']) {
    const { reader } = world({ records: [record({ state })] });
    const trace = await reader.get('d1', subject());
    const tree = buildTree(trace!);
    assert.equal(tree.unrecorded.length, 0, state);
    assert.ok(tree.roots[0]?.node.attrs.some((attr) => attr.key === '结果' && attr.value.length > 0), state);
  }
});

test('结果读取只发生在授权后、扫描上限内，找到 limit+1 条即停止', async () => {
  const records = Array.from({ length: AGENT_SCAN + 1 }, (_, i) =>
    record({ id: `d${i}`, seq: i + 1, createdAt: NOW + AGENT_SCAN - i })
  );
  const { reader, calls } = world({ records });
  const list = await reader.list(query({ needsLook: true, limit: 2 }), subject());
  assert.deepEqual(list.items.map((item) => item.id), ['agent:d0', 'agent:d1']);
  assert.equal(list.truncated, true);
  assert.deepEqual(calls.ended.map((call) => call.deliveryId), ['d0', 'd1', 'd2']);

  const denied = world({ sessions: [sessionOf({ createdBy: 'u2' })] });
  assert.deepEqual((await denied.reader.list(query({ needsLook: true }), subject())).items, []);
  assert.equal(await denied.reader.get('d1', subject()), null);
  assert.deepEqual(denied.calls.ended, []);

  const bounded = world({ records });
  await bounded.reader.list(query({ needsLook: true, limit: 1000 }), subject());
  assert.equal(bounded.calls.ended.length, AGENT_SCAN);
  assert.equal(bounded.calls.ended.some((call) => call.deliveryId === `d${AGENT_SCAN}`), false);
});
