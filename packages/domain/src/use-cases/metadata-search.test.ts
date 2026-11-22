import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { User, Principal } from '../account.ts';
import type { CustomRole } from '../access.ts';
import type { AccessPolicy } from './authorization.ts';
import {
  METADATA_SEARCH_GROUP_LIMIT,
  METADATA_SEARCH_GROUP_MAX,
  METADATA_SEARCH_QUERY_MAX,
  type MetadataSearchGateway,
  type MetadataSearchGroups,
  type MetadataSearchQuery,
  type SessionMetadataHit
} from '../ports/metadata-search.ts';
import { createProject, type Project } from '../project.ts';
import { asProjectId, asSessionId, asTaskId } from '../ids.ts';
import { metadataSearchUseCase, type MetadataSearchDeps } from './metadata-search.ts';

const ctx = { hubTeamId: 'hub', settings: { membersCanAddMachines: false } } as const;
const policy: AccessPolicy = {
  context: async () => ctx,
  worker: async (workerId) => ({ kind: 'worker', id: workerId ?? 'local', teamId: 'hub', createdBy: null })
};

function principal(id: string, role: User['role'], teamId = 'hub'): Principal {
  return {
    user: { id, email: `${id}@b.co`, role, disabledAt: null, deletedAt: null, teamId, clusterAdmin: false },
    loginId: `l-${id}`
  } as unknown as Principal;
}

const member = principal('mem', 'member');
const viewer = principal('vw', 'viewer');
const outsider = principal('out', 'owner', 'other');

function project(
  id: string,
  options: { createdBy?: string; members?: readonly string[]; teamId?: string; deletedAt?: number | null; name?: string } = {}
): Project {
  const created = createProject({
    id: asProjectId(id),
    name: options.name ?? id,
    now: 1,
    teamId: options.teamId ?? 'hub',
    createdBy: options.createdBy ?? 'owner'
  });
  assert.ok(created.ok);
  return { ...created.value, members: options.members ?? [], deletedAt: options.deletedAt ?? null };
}

function sessionHit(
  id: string,
  options: { taskId?: string | null; projectId?: string | null; originProjectId?: string | null; title?: string | null; taskTitle?: string | null } = {}
): SessionMetadataHit {
  return {
    sessionId: asSessionId(id),
    taskId: options.taskId === undefined ? null : options.taskId === null ? null : asTaskId(options.taskId),
    projectId: options.projectId === undefined || options.projectId === null ? null : asProjectId(options.projectId),
    originProjectId:
      options.originProjectId === undefined || options.originProjectId === null ? null : asProjectId(options.originProjectId),
    title: options.title ?? null,
    taskTitle: options.taskTitle ?? null,
    updatedAt: 10
  };
}

function world(projects: readonly Project[], groups: Partial<MetadataSearchGroups>, access: AccessPolicy | null = policy) {
  const calls: MetadataSearchQuery[] = [];
  let listCalls = 0;
  let contextCalls = 0;
  const gateway: MetadataSearchGateway = {
    async search(query) {
      calls.push(query);
      return { projects: groups.projects ?? [], tasks: groups.tasks ?? [], sessions: groups.sessions ?? [] };
    }
  };
  const countedAccess: AccessPolicy | undefined =
    access === null
      ? undefined
      : {
          ...access,
          context: async () => {
            contextCalls++;
            return access.context();
          }
        };
  const deps: MetadataSearchDeps = {
    projects: {
      list: async () => {
        listCalls++;
        return [...projects];
      }
    },
    metadataSearch: gateway,
    ...(countedAccess === undefined ? {} : { access: countedAccess })
  };
  return { deps, calls, listCalls: () => listCalls, contextCalls: () => contextCalls };
}

test('空词与超长词在进 SQL 之前就被拒绝', async () => {
  const w = world([], {});
  for (const query of ['', '   ', 'x'.repeat(METADATA_SEARCH_QUERY_MAX + 1)]) {
    const result = await metadataSearchUseCase(w.deps, member, { query });
    assert.equal(!result.ok && result.error.code, 'invalid');
  }
  assert.deepEqual(w.calls, [], '非法输入不调用存储层');
  assert.equal(w.listCalls(), 0, '非法输入不列项目');
  assert.equal(w.contextCalls(), 0, '非法输入不读 policy context');
});

test('按组返回，保持存储层顺序，并带上授权项目名', async () => {
  const p1 = project('p-1', { name: '甲', createdBy: 'mem' });
  const p2 = project('p-2', { name: '乙', createdBy: 'mem' });
  const w = world([p1, p2], {
    projects: [{ projectId: p2.id }, { projectId: p1.id }],
    tasks: [{ taskId: asTaskId('t-1'), projectId: p1.id, title: '零会话任务' }],
    sessions: [sessionHit('s-1', { projectId: p1.id, taskId: 't-1', title: '命名会话', taskTitle: '零会话任务' })]
  });

  const result = await metadataSearchUseCase(w.deps, member, { query: ' 甲 ' });
  assert.ok(result.ok);
  assert.deepEqual(result.value.projects.map((item) => item.name), ['乙', '甲'], '顺序由存储层决定，名字用项目仓库的规范值');
  assert.equal(result.value.tasks[0]?.projectName, '甲');
  assert.equal(result.value.sessions[0]?.title, '命名会话');
  assert.equal(result.value.sessions[0]?.taskTitle, '零会话任务');
  assert.equal(w.calls[0]?.query, '甲', '传给存储层的是 trim 后的词');
  assert.deepEqual(w.calls[0]?.scope.projects, [p1.id, p2.id]);
  assert.deepEqual(w.calls[0]?.scope.tasks, [p1.id, p2.id]);
  assert.deepEqual(w.calls[0]?.scope.sessions, [p1.id, p2.id]);
  assert.equal(w.listCalls(), 1);
  assert.equal(w.contextCalls(), 1, '三个组共用一次 policy context');
});

test('member 只看自己建的和共享给自己的项目；别的团队 / 回收站不出现', async () => {
  const own = project('p-own', { createdBy: 'mem' });
  const shared = project('p-shared', { createdBy: 'other', members: ['mem'] });
  const privateProject = project('p-private', { createdBy: 'other' });
  const otherTeam = project('p-other-team', { createdBy: 'mem', teamId: 'other' });
  const deleted = project('p-deleted', { createdBy: 'mem', deletedAt: 1 });
  const w = world([own, shared, privateProject, otherTeam, deleted], {
    projects: [own, shared, privateProject, otherTeam, deleted].map((item) => ({ projectId: item.id }))
  });

  const result = await metadataSearchUseCase(w.deps, member, { query: 'p' });
  assert.ok(result.ok);
  assert.deepEqual(result.value.projects.map((item) => item.projectId), [own.id, shared.id]);
  assert.deepEqual(w.calls[0]?.scope.projects, [own.id, shared.id]);
  assert.deepEqual(w.calls[0]?.scope.tasks, [own.id, shared.id]);
  assert.deepEqual(w.calls[0]?.scope.sessions, [own.id, shared.id]);
});

test('viewer 能看本团队全部项目（含别人没共享的），但看不到别的团队', async () => {
  const own = project('p-own', { createdBy: 'other' });
  const privateProject = project('p-private', { createdBy: 'other' });
  const otherTeam = project('p-other-team', { createdBy: 'other', teamId: 'other' });
  const w = world([own, privateProject, otherTeam], {
    projects: [own, privateProject, otherTeam].map((item) => ({ projectId: item.id }))
  });

  const result = await metadataSearchUseCase(w.deps, viewer, { query: 'p' });
  assert.ok(result.ok);
  assert.deepEqual(result.value.projects.map((item) => item.projectId), [own.id, privateProject.id]);
  assert.deepEqual(w.calls[0]?.scope.projects, [own.id, privateProject.id]);
});

test('自定义角色只有 session.read、没有 project.read 时，仍不能越过项目可见性', async () => {
  const p = project('p-team', { createdBy: 'other' });
  const role: CustomRole = {
    id: 'r-session-reader',
    teamId: 'hub',
    name: '会话观察',
    permissions: { 'session.read': 'team' },
    createdBy: 'owner',
    createdAt: 1,
    updatedAt: 1
  };
  const observer = {
    user: {
      id: 'obs',
      email: 'obs@b.co',
      role: 'custom:r-session-reader',
      disabledAt: null,
      deletedAt: null,
      teamId: 'hub',
      clusterAdmin: false
    },
    loginId: 'l-obs',
    customRole: role
  } as unknown as Principal;
  const w = world([p], {
    projects: [{ projectId: p.id }],
    tasks: [{ taskId: asTaskId('t-1'), projectId: p.id, title: '任务' }],
    sessions: [sessionHit('s-1', { projectId: p.id, taskId: 't-1' })]
  });

  const result = await metadataSearchUseCase(w.deps, observer, { query: 'p' });
  assert.ok(result.ok);
  assert.deepEqual(result.value.projects, []);
  assert.deepEqual(result.value.tasks, []);
  assert.deepEqual(result.value.sessions, []);
  assert.deepEqual(w.calls[0]?.scope, { projects: [], tasks: [], sessions: [] });
});

test('容器会话只认不可变出生项目：hit.projectId 不能把它带进私有项目', async () => {
  const visible = project('p-visible', { createdBy: 'other', members: ['mem'] });
  const privateProject = project('p-private', { createdBy: 'other' });
  const w = world([visible, privateProject], {
    sessions: [
      // 出生在共享项目 → 可见；projectId 指向私有项目也不影响。
      sessionHit('s-visible', { projectId: 'p-private', originProjectId: 'p-visible' }),
      // 出生在私有项目 → 不可见；projectId 指向共享项目也不能洗白。
      sessionHit('s-hidden', { projectId: 'p-visible', originProjectId: 'p-private' }),
      // 没有出生项目 → 失败关闭，即使带着一个可见的 projectId。
      sessionHit('s-null-origin', { projectId: 'p-visible' })
    ]
  });

  const result = await metadataSearchUseCase(w.deps, member, { query: 's-' });
  assert.ok(result.ok);
  assert.deepEqual(result.value.sessions.map((item) => item.sessionId), [asSessionId('s-visible')]);
  assert.deepEqual(w.calls[0]?.scope.sessions, [visible.id], '存储层只拿到可见出生项目');
});

test('任务会话按任务项目授权，出生项目不参与', async () => {
  const visible = project('p-visible', { createdBy: 'other', members: ['mem'] });
  const privateProject = project('p-private', { createdBy: 'other' });
  const w = world([visible, privateProject], {
    sessions: [
      sessionHit('s-task-hidden', { projectId: 'p-private', taskId: 't-1', originProjectId: 'p-visible' }),
      sessionHit('s-task-visible', { projectId: 'p-visible', taskId: 't-2', originProjectId: 'p-private' })
    ]
  });

  const result = await metadataSearchUseCase(w.deps, member, { query: 's-' });
  assert.ok(result.ok);
  assert.deepEqual(result.value.sessions.map((item) => item.sessionId), [asSessionId('s-task-visible')]);
  assert.deepEqual(w.calls[0]?.scope.sessions, [visible.id], '任务会话只按任务项目授权');
});

test('每组条数夹到 1..上限；scope 在存储层 LIMIT 之前生效', async () => {
  const p = project('p-1', { createdBy: 'mem' });
  const sessions = Array.from({ length: 25 }, (_, index) =>
    sessionHit(`s-${index}`, { projectId: 'p-1', taskId: `t-${index}` })
  );
  const w = world([p], { sessions });

  const low = await metadataSearchUseCase(w.deps, member, { query: 's', limitPerGroup: 0 });
  assert.ok(low.ok);
  assert.equal(w.calls.at(-1)?.limitPerGroup, 1, '0 被夹到 1');
  assert.equal(low.value.sessions.length, 1);
  assert.deepEqual(w.calls.at(-1)?.scope.sessions, [p.id]);

  const high = await metadataSearchUseCase(w.deps, member, { query: 's', limitPerGroup: 999 });
  assert.ok(high.ok);
  assert.equal(w.calls.at(-1)?.limitPerGroup, METADATA_SEARCH_GROUP_MAX);
  assert.equal(high.value.sessions.length, METADATA_SEARCH_GROUP_MAX);

  const fallback = await metadataSearchUseCase(w.deps, member, { query: 's', limitPerGroup: Number.NaN });
  assert.ok(fallback.ok);
  assert.equal(w.calls.at(-1)?.limitPerGroup, METADATA_SEARCH_GROUP_LIMIT);
  assert.equal(fallback.value.sessions.length, METADATA_SEARCH_GROUP_LIMIT);
});

test('没有 access policy 时只排除回收站（单机语义）', async () => {
  const live = project('p-live', { createdBy: 'other' });
  const deleted = project('p-deleted', { createdBy: 'other', deletedAt: 1 });
  const w = world(
    [live, deleted],
    { projects: [live, deleted].map((item) => ({ projectId: item.id })) },
    null
  );

  const result = await metadataSearchUseCase(w.deps, outsider, { query: 'p' });
  assert.ok(result.ok);
  assert.deepEqual(result.value.projects.map((item) => item.projectId), [live.id]);
  assert.deepEqual(w.calls[0]?.scope.projects, [live.id]);
  assert.deepEqual(w.calls[0]?.scope.tasks, [live.id]);
  assert.deepEqual(w.calls[0]?.scope.sessions, [live.id]);
});
