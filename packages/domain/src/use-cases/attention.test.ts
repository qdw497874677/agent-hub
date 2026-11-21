import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asAgentId } from '../ids.ts';
import { createProject } from '../project.ts';
import { createTask } from '../task.ts';
import { deriveSession } from '../session.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import type { AttentionAck, AttentionStore } from '../ports/attention-store.ts';
import { ATTENTION_SESSION_ID_MAX, attentionTarget, loadAttention, markAttention, type AttentionDeps } from './attention.ts';

/** 最小内存版 attention_ack：只证明用例怎么用端口，SQL 行为在 storage-sqlite 单独测。 */
function memoryAttention(): AttentionStore & { rows: { accountId: string; ack: AttentionAck; at: number }[] } {
  const rows: { accountId: string; ack: AttentionAck; at: number }[] = [];
  const same = (a: AttentionAck, b: AttentionAck) => a.sessionId === b.sessionId && a.phase === b.phase && a.since === b.since;
  return {
    rows,
    async ack(accountId, ack, at) {
      const found = rows.find((r) => r.accountId === accountId && same(r.ack, ack));
      if (found) return found.at;
      rows.push({ accountId, ack, at });
      return at;
    },
    async unack(accountId, ack, receipt) {
      const index = rows.findIndex(
        (r) => r.accountId === accountId && same(r.ack, ack) && (receipt === undefined || r.at === receipt)
      );
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
    async acks(accountId) {
      return rows.filter((r) => r.accountId === accountId).map((r) => r.ack);
    }
  };
}

/** 一个项目 + 任务 + 一条失败（要人看）的会话。默认发起人和负责人都算 u1。 */
async function setup(input: { creator?: string; owner?: string } = {}) {
  const world = inMemoryDeps();
  const project = createProject({ name: 'p', now: 1 });
  assert.ok(project.ok);
  await world.deps.projects.save(project.value);
  const task = createTask({ projectId: project.value.id, title: 't', now: 1, ownerId: input.owner ?? 'u1' });
  assert.ok(task.ok);
  await world.deps.tasks.save(task.value);
  const session = deriveSession({
    task: task.value,
    agentId: asAgentId('a'),
    model: 'm',
    now: 1,
    createdBy: input.creator ?? 'u1'
  });
  assert.ok(session.ok);
  await world.deps.sessions.save({ ...session.value, status: 'failed' });
  const attention = memoryAttention();
  const deps: AttentionDeps = {
    projects: world.deps.projects,
    tasks: world.deps.tasks,
    sessions: world.deps.sessions,
    attention
  };
  return { deps, attention, project: project.value, task: task.value, session: session.value };
}

test('attention：记下之后不再列，撤销之后回来（刷新读同一份状态）', async () => {
  const { deps, session } = await setup();
  const before = await loadAttention(deps, { accountId: 'u1', now: 100 });
  const item = before.items.find((i) => i.sessionId === session.id);
  assert.ok(item, '失败会话应先上榜');
  assert.equal(item.phase, 'failed');

  const marked = await markAttention(deps, {
    accountId: 'u1',
    sessionId: session.id,
    phase: item.phase,
    since: item.since,
    acked: true,
    at: 500
  });
  assert.equal(marked.ackedAt, 500);
  // 刷新 = 再读一次（不是内存里删掉）
  assert.deepEqual((await loadAttention(deps, { accountId: 'u1', now: 100 })).items, []);

  const undone = await markAttention(deps, {
    accountId: 'u1',
    sessionId: session.id,
    phase: item.phase,
    since: item.since,
    acked: false,
    receipt: marked.ackedAt as number,
    at: 600
  });
  assert.equal(undone.ackedAt, null);
  assert.deepEqual(
    (await loadAttention(deps, { accountId: 'u1', now: 100 })).items.map((i) => i.sessionId),
    [session.id]
  );
});

test('attention：撤销只动精确的那一条，别的阶段 / 进入时刻不受影响', async () => {
  const { deps, attention, session } = await setup();
  const base = { accountId: 'u1', sessionId: session.id, acked: true } as const;
  await markAttention(deps, { ...base, phase: 'failed', since: 10, at: 1 });
  await markAttention(deps, { ...base, phase: 'needs_review', since: 10, at: 2 });
  await markAttention(deps, { ...base, phase: 'failed', since: 11, at: 3 });

  await markAttention(deps, { accountId: 'u1', sessionId: session.id, phase: 'failed', since: 10, acked: false, at: 4 });
  assert.deepEqual(
    (await attention.acks('u1')).map((a) => `${a.phase}|${a.since}`),
    ['needs_review|10', 'failed|11']
  );
});

test('attention：不是会话发起人、也不是任务负责人 → 记不下，也撤销不了别人的', async () => {
  const { deps, attention, session } = await setup({ creator: 'alice', owner: 'bob' });
  const record = await markAttention(deps, {
    accountId: 'mallory',
    sessionId: session.id,
    phase: 'failed',
    since: 10,
    acked: true,
    at: 1
  });
  assert.equal(record.ackedAt, null);
  assert.equal(attention.rows.length, 0);
  assert.equal(await attentionTarget(deps, { accountId: 'mallory', sessionId: session.id }), null);

  // 老数据里可能已经有 alice 的记录：mallory 的撤销也不能删
  await markAttention(deps, { accountId: 'alice', sessionId: session.id, phase: 'failed', since: 10, acked: true, at: 1 });
  assert.equal(attention.rows.length, 1);
  const undone = await markAttention(deps, {
    accountId: 'mallory',
    sessionId: session.id,
    phase: 'failed',
    since: 10,
    acked: false,
    at: 2
  });
  assert.equal(undone.ackedAt, null);
  assert.equal(attention.rows.length, 1);
});

test('attention：会话发起人或任务负责人各算一半权限', async () => {
  const asCreator = await setup({ creator: 'alice', owner: 'bob' });
  const creatorAck = await markAttention(asCreator.deps, {
    accountId: 'alice',
    sessionId: asCreator.session.id,
    phase: 'failed',
    since: 10,
    acked: true,
    at: 1
  });
  assert.equal(creatorAck.ackedAt, 1);

  const asOwner = await setup({ creator: 'alice', owner: 'bob' });
  const ownerAck = await markAttention(asOwner.deps, {
    accountId: 'bob',
    sessionId: asOwner.session.id,
    phase: 'failed',
    since: 10,
    acked: true,
    at: 1
  });
  assert.equal(ownerAck.ackedAt, 1);
});

test('attention：容器会话 / 看不见的项目 / 超长 id 一律当作没有', async () => {
  const world = inMemoryDeps();
  const attention = memoryAttention();
  const deps: AttentionDeps = {
    projects: world.deps.projects,
    tasks: world.deps.tasks,
    sessions: world.deps.sessions,
    attention
  };
  const container = deriveSession({ agentId: asAgentId('a'), model: 'm', now: 1, createdBy: 'u1' });
  assert.ok(container.ok);
  await world.deps.sessions.save({ ...container.value, status: 'failed' });
  assert.equal(
    await markAttention(deps, {
      accountId: 'u1',
      sessionId: container.value.id,
      phase: 'failed',
      since: 10,
      acked: true,
      at: 1
    }).then((r) => r.ackedAt),
    null
  );

  const visible = await setup();
  const hidden = await markAttention(visible.deps, {
    accountId: 'u1',
    sessionId: visible.session.id,
    phase: 'failed',
    since: 10,
    acked: true,
    at: 1,
    include: () => false
  });
  assert.equal(hidden.ackedAt, null);
  assert.equal(visible.attention.rows.length, 0);

  assert.equal(
    await attentionTarget(visible.deps, { accountId: 'u1', sessionId: 'x'.repeat(ATTENTION_SESSION_ID_MAX + 1) }),
    null
  );
  assert.equal(await attentionTarget(visible.deps, { accountId: 'u1', sessionId: 'no-such-session' }), null);
});
