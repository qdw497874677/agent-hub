import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from '../result.ts';
import type { Session } from '../session.ts';
import type { ToolGrant } from '../tool.ts';
import { createSessionControlToolProvider, SESSION_CONTROL_TOOLS } from './session-control-tools.ts';
import type { DeriveCommand } from '../use-cases/sessions.ts';

const project = { id: 'p1', name: 'app', teamId: 't', createdBy: 'u1', members: [] };
const otherProject = { id: 'p2', name: 'other', teamId: 't', createdBy: 'u1', members: [] };

const session = (over: Partial<Session> = {}): Session => ({
  id: 's1',
  taskId: 't1' as never,
  workspaceId: 'w1',
  groupId: null,
  botId: null,
  workerId: 'w1',
  agentId: 'opencode',
  model: 'm1',
  options: {},
  createdBy: 'u1',
  status: 'running',
  lastSeq: 0,
  title: null,
  createdAt: 1,
  updatedAt: 1,
  ...over
} as unknown as Session);

const grant = (sessionId = 's1'): ToolGrant => ({
  id: 'g1',
  tokenHash: 'h',
  taskId: 't1' as never,
  sessionId: sessionId as never,
  workerId: 'w1',
  scopes: ['session:control'],
  createdAt: 1,
  expiresAt: 2,
  revokedAt: null
});

function world(
  items: Record<string, Session>,
  tasksOf: Record<string, string> = { t1: 'p1' },
  extra: {
    sessionsOfProject?: Record<string, string>;
    policy?: boolean;
    actor?: string;
    workspaceProject?: string | null;
    projectMembers?: readonly string[];
  } = {}
) {
  const derived: DeriveCommand[] = [];
  const stopped: string[] = [];
  const provider = createSessionControlToolProvider({
    sessions: { byId: async (id) => items[id as string] ?? null },
    tasks: { byId: async (id) => (tasksOf[id as string] ? { id, projectId: tasksOf[id as string] } : null) as never },
    projects: {
      byId: async (id) => {
        const found = [project, otherProject].find((p) => p.id === id);
        if (!found) return null;
        return { ...found, members: extra.projectMembers ?? found.members } as never;
      }
    },
    workspaceGroups: { byId: async () => null },
    bots: { byId: async () => null },
    workspaces: {
      byId: async (id) => {
        const projectId = extra.sessionsOfProject?.[id as string] ?? (extra.workspaceProject === undefined ? 'p1' : extra.workspaceProject);
        return (projectId === null ? { id } : { id, projectId }) as never;
      }
    },
    access: extra.policy
      ? ({
          context: async () => ({ hubTeamId: 't', settings: { openRegistration: false, membersCanAddMachines: true, refuseWhenFull: [] } }),
          worker: async () => ({ kind: 'worker', id: 'w1', teamId: 't', createdBy: null, local: true })
        } as never)
      : undefined,
    subjectOf: extra.actor
      ? async () =>
          ({
            loginId: 'l1',
            user: { id: extra.actor, name: extra.actor, teamId: 't', role: 'member', createdAt: 1, disabledAt: null, deletedAt: null }
          } as never)
      : undefined,
    derive: async (command) => {
      derived.push(command);
      return ok(session({ id: 's2', status: 'running' } as never));
    },
    interrupt: async (id) => {
      stopped.push(id);
      return ok(undefined);
    }
  });
  return { provider, derived, stopped };
}

test('工具面只有两个：派生与停止，且都走 session:control', () => {
  assert.deepEqual(SESSION_CONTROL_TOOLS.map((t) => t.name).sort(), ['session.derive', 'session.stop']);
  assert.ok(SESSION_CONTROL_TOOLS.every((t) => t.scope === 'session:control'));
});

test('派生：继承调用方的任务、运行时、模型与工作空间', async () => {
  const { provider, derived } = world({ s1: session() });
  const result = await provider.call('session.derive', { title: '  试一下  ' }, { grant: grant() } as never);
  assert.equal(result.ok, true);
  assert.equal(derived.length, 1);
  assert.equal(derived[0]!.taskId, 't1');
  assert.equal(derived[0]!.workspaceId, 'w1');
  assert.equal(derived[0]!.ref?.runtime, 'opencode');
  assert.equal(derived[0]!.ref?.model, 'm1');
  assert.equal(derived[0]!.actor, null, '没注入 subjectOf 时保持旧行为');
  assert.deepEqual(result.ok ? result.value : null, { session_id: 's2', task_id: 't1', project_id: 'p1', title: '试一下' });
});

test('派生：容器会话没有任务时用项目落地', async () => {
  const { provider, derived } = world({ s1: session({ taskId: null } as never) });
  const result = await provider.call('session.derive', {}, { grant: grant() } as never);
  assert.equal(result.ok, true);
  assert.equal(derived[0]!.taskId, undefined);
  assert.equal(derived[0]!.projectId, 'p1');
});

test('停止：默认停自己', async () => {
  const { provider, stopped } = world({ s1: session() });
  const result = await provider.call('session.stop', {}, { grant: grant() } as never);
  assert.deepEqual(result.ok ? result.value : null, { session_id: 's1', stopped: true });
  assert.deepEqual(stopped, ['s1']);
});

test('停止：同项目允许，别的项目拒绝', async () => {
  const sameProject = world({ s1: session(), s2: session({ id: 's2' } as never) });
  const allowed = await sameProject.provider.call('session.stop', { session_id: 's2' }, { grant: grant() } as never);
  assert.equal(allowed.ok, true);
  assert.deepEqual(sameProject.stopped, ['s2']);

  const other = world({ s1: session(), s9: session({ id: 's9', taskId: 't9' } as never) }, { t1: 'p1', t9: 'p2' });
  const denied = await other.provider.call('session.stop', { session_id: 's9' }, { grant: grant() } as never);
  assert.equal(denied.ok, false);
  assert.deepEqual(other.stopped, []);
});

test('派生：带上冻结的调用方身份；subjectOf 缺省时仍是 null', async () => {
  const withActor = world({ s1: session() }, { t1: 'p1' }, { policy: true, actor: 'u1' });
  await withActor.provider.call('session.derive', {}, { grant: grant() } as never);
  assert.equal((withActor.derived[0]!.actor as { user?: { id?: string } } | null)?.user?.id, 'u1');
});

test('停止：自己停自己不看项目；容器会话落不了项目时保持 not_found（#227）', async () => {
  const orphan = world(
    { s1: session({ id: 's1', taskId: null, groupId: null } as never) },
    {},
    { policy: true, actor: 'u1', workspaceProject: null }
  );
  const own = await orphan.provider.call('session.stop', {}, { grant: grant() } as never);
  assert.equal(own.ok, false);
  if (!own.ok) assert.equal(own.error.code, 'not_found');
  assert.deepEqual(orphan.stopped, []);
});

test('停止：有策略时不能停别人建的会话（#227）', async () => {
  const { provider, stopped } = world(
    { s1: session(), s2: session({ id: 's2', createdBy: 'u1' } as never) },
    { t1: 'p1' },
    { policy: true, actor: 'u2' }
  );
  const denied = await provider.call('session.stop', { session_id: 's2' }, { grant: grant() } as never);
  assert.equal(denied.ok, false);
  // 看不见项目时是 404（不泄露存在），不是 403。
  if (!denied.ok) assert.equal(denied.error.code, 'not_found');
  assert.deepEqual(stopped, []);

  const own = world({ s1: session(), s2: session({ id: 's2' } as never) }, { t1: 'p1' }, { policy: true, actor: 'u1' });
  const allowed = await own.provider.call('session.stop', { session_id: 's2' }, { grant: grant() } as never);
  assert.equal(allowed.ok, true, allowed.ok ? '' : allowed.error.message);
  assert.deepEqual(own.stopped, ['s2']);
});

test('停止：看得见但不是创建者（共享成员）也停不了，返回 forbidden（#227）', async () => {
  const shared = world(
    { s1: session(), s2: session({ id: 's2', createdBy: 'u1' } as never) },
    { t1: 'p1' },
    { policy: true, actor: 'u2', projectMembers: ['u2'] }
  );
  // u2 被共享了项目：看得见，但不是会话创建者 → forbidden（不是 404）。
  const denied = await shared.provider.call('session.stop', { session_id: 's2' }, { grant: grant() } as never);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, 'forbidden');
  assert.deepEqual(shared.stopped, []);
});

test('停止：有策略时自己停自己仍然可以（项目可见、创建者）', async () => {
  const own = world({ s1: session() }, { t1: 'p1' }, { policy: true, actor: 'u1' });
  const result = await own.provider.call('session.stop', {}, { grant: grant() } as never);
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
  assert.deepEqual(own.stopped, ['s1']);
});

test('停止：已经不在运行就不再去停', async () => {
  const { provider, stopped } = world({ s1: session(), s2: session({ id: 's2', status: 'done' } as never) });
  const result = await provider.call('session.stop', { session_id: 's2' }, { grant: grant() } as never);
  assert.deepEqual(result.ok ? result.value : null, { session_id: 's2', stopped: false, reason: '这条会话不在运行' });
  assert.deepEqual(stopped, []);
});
