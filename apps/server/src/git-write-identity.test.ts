import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type Session,
  type SessionId,
  type SessionProvenance,
  type Subject,
  type TaskDispatch,
  type ToolContext,
  type ToolGrant,
  type WorkspaceDelegation
} from '@agent-hub/domain';
import { createGitWriteSubjectOf } from './git-write-identity.ts';

const subject = { user: { id: 'u1', email: 'u1@example.com' } } as unknown as Subject;

const session = (over: Partial<Session> = {}): Session =>
  ({ id: 's1', taskId: 't1', createdBy: 'u1', botId: null, ...over }) as unknown as Session;

const provenance = (over: Partial<SessionProvenance> = {}): SessionProvenance => ({
  id: 'p1',
  sessionId: 's1',
  taskId: 't1',
  actor: { kind: 'user', id: 'u1', name: 'U1' },
  via: 'web',
  parent: null,
  authority: { role: 'owner' },
  backfilled: false,
  createdAt: 1,
  ...over
});

const ctx = (actor?: { readonly userId: string | null; readonly via: 'web' | 'bot' | 'group' | 'connector' | 'dispatch' }): ToolContext => ({
  grant: {
    sessionId: 's1',
    taskId: 't1',
    scopes: ['git'],
    ...(actor ? { actor } : {})
  } as unknown as ToolGrant,
  now: 1
});

function world(
  over: {
    readonly session?: Session | null;
    readonly botOfSession?: { readonly botId: string | null } | null;
    readonly spawnOf?: { readonly role: string } | null;
    readonly memberOfSession?: { readonly role: string } | null;
    readonly provenance?: SessionProvenance | null;
    readonly dispatch?: TaskDispatch | null;
    readonly subjectResult?: Subject | null;
    readonly delegated?: boolean;
  } = {}
) {
  const calls = { subject: [] as string[], bot: [] as string[] };
  const fn = createGitWriteSubjectOf({
    sessions: {
      byId: async (id: SessionId) => (id === ('s1' as SessionId) ? (over.session === undefined ? session() : over.session) : null)
    },
    botOfSession: async (id: SessionId) => {
      calls.bot.push(id);
      return over.botOfSession ?? null;
    },
    spawnOf: async () => over.spawnOf ?? null,
    memberOfSession: async () => over.memberOfSession ?? null,
    provenance: { get: async () => over.provenance ?? null },
    dispatches: { bySession: async () => over.dispatch ?? null },
    delegations: {
      byExecutionSession: async (id: SessionId) => (over.delegated && id === ('s1' as SessionId) ? ({ executionSessionId: id } as WorkspaceDelegation) : null)
    },
    subjectOf: async (id: SessionId) => {
      calls.subject.push(id);
      return over.subjectResult === undefined ? subject : over.subjectResult;
    }
  });
  return { fn, calls };
}

test('#217 写入身份：普通用户会话保留写权限，走原来的 subjectOf', async () => {
  const { fn, calls } = world();
  const res = await fn('s1' as SessionId, ctx());
  assert.ok(res.ok);
  assert.equal(res.value, subject);
  assert.deepEqual(calls.subject, ['s1']);
});

test('#217 写入身份：sessions.bot_id 标记的会话一律拒写，不看冻结 actor / createdBy', async () => {
  const { fn, calls } = world({ session: session({ botId: 'bot1' as never }) });
  const res = await fn('s1' as SessionId, ctx({ userId: 'u1', via: 'web' }));
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.error.code, 'forbidden');
  assert.deepEqual(calls.subject, [], '共享会话不能回落到 subjectOf');
});

test('#217 写入身份：老 bot 会话的兼容反查、spawn / 群成员映射都拒绝', async () => {
  for (const over of [{ botOfSession: { botId: null } }, { spawnOf: { role: 'router' } }, { memberOfSession: { role: 'router' } }]) {
    const { fn, calls } = world(over);
    const res = await fn('s1' as SessionId, ctx());
    assert.equal(!res.ok && res.error.code, 'forbidden', JSON.stringify(over));
    assert.deepEqual(calls.subject, []);
  }
});

test('#217 写入身份：来历 via=bot/group 或非人类 actor 拒绝；回填的老会话不因此误杀', async () => {
  for (const via of ['bot', 'group'] as const) {
    const { fn } = world({ provenance: provenance({ via }) });
    const res = await fn('s1' as SessionId, ctx());
    assert.equal(!res.ok && res.error.code, 'forbidden', via);
  }

  const agent = world({ provenance: provenance({ actor: { kind: 'agent', id: 'a1', name: 'A1' } }) });
  assert.equal((await agent.fn('s1' as SessionId, ctx())).ok, false);

  const legacy = world({ provenance: provenance({ actor: { kind: 'system', id: 'legacy', name: '补录' }, backfilled: true }) });
  assert.ok((await legacy.fn('s1' as SessionId, ctx())).ok);
});

test('#217 写入身份：调度器 / 连接器派生的任务会话拒绝；未知会话 / 找不到账号也拒绝', async () => {
  for (const dispatch of [{ originConnector: 'github' }, { originConnector: null }]) {
    const dispatched = world({ dispatch: dispatch as unknown as TaskDispatch });
    assert.equal((await dispatched.fn('s1' as SessionId, ctx())).ok, false, JSON.stringify(dispatch));
  }

  const missing = world({ session: null });
  const missingRes = await missing.fn('s1' as SessionId, ctx());
  assert.equal(!missingRes.ok && missingRes.error.code, 'forbidden');

  const nobody = world({ subjectResult: null });
  assert.equal((await nobody.fn('s1' as SessionId, ctx())).ok, false);
});

test('#217 写入身份：冻结 grant.actor 带 bot/群/连接器来源或没有人类账号时也不放行', async () => {
  for (const via of ['bot', 'group', 'connector', 'dispatch'] as const) {
    const { fn, calls } = world();
    const res = await fn('s1' as SessionId, ctx({ userId: 'u1', via }));
    assert.equal(!res.ok && res.error.code, 'forbidden', via);
    assert.deepEqual(calls.subject, []);
  }

  const anonymous = world();
  const res = await anonymous.fn('s1' as SessionId, ctx({ userId: null, via: 'web' }));
  assert.equal(!res.ok && res.error.code, 'forbidden');
  assert.deepEqual(anonymous.calls.subject, [], '没有人类账号时不能回落到 createdBy');
});

test('派工执行会话：持久派工身份先于冻结 actor / subject 解析，一律拒写', async () => {
  // 即使来历、冻结 grant.actor 和 subjectOf 都看起来像人类，派工执行会话也不能写。
  const delegated = world({
    delegated: true,
    provenance: provenance(),
    subjectResult: subject
  });
  const res = await delegated.fn('s1' as SessionId, ctx({ userId: 'u1', via: 'web' }));
  assert.equal(!res.ok && res.error.code, 'forbidden');
  assert.match(res.ok ? '' : res.error.message, /派工执行会话/);
  assert.deepEqual(delegated.calls.subject, [], '派工身份命中后不再回落到 subjectOf');
  assert.deepEqual(delegated.calls.bot, [], '派工判定在读 bot 兼容映射之前');

  // 没有派工记录的同一会话照旧可写（普通会话行为不变）。
  const regular = world({ provenance: provenance() });
  assert.ok((await regular.fn('s1' as SessionId, ctx({ userId: 'u1', via: 'web' }))).ok);
});
