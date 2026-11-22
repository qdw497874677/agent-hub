import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { createTaskWithReplayUseCase, TASK_CREATE_OPERATION } from './task-creation.ts';
import { createTask } from '../task.ts';
import type { TaskCreationStore } from '../ports/task-creation-store.ts';
import type { Task } from '../task.ts';
import type { ProjectId, SessionId } from '../ids.ts';

interface Recorded {
  readonly key: string;
  readonly actorId: string;
  readonly sourceSessionId: SessionId | null;
  readonly projectId: ProjectId;
  readonly operation: string;
  readonly fingerprint: string;
  readonly task: Task;
}

function fakeCreations(tasks: { save(task: Task): Promise<void> }): TaskCreationStore & {
  readonly calls: Recorded[];
  readonly byKey: Map<string, Recorded>;
} {
  const calls: Recorded[] = [];
  const byKey = new Map<string, Recorded>();
  return {
    calls,
    byKey,
    async createWithReplay(intent) {
      calls.push({ ...intent });
      const existing = byKey.get(intent.key);
      if (existing) {
        if (existing.fingerprint !== intent.fingerprint) return { status: 'conflict' };
        return { status: 'replayed', task: existing.task };
      }
      byKey.set(intent.key, { ...intent });
      await tasks.save(intent.task);
      return { status: 'created', task: intent.task };
    },
    async listByParent(projectId, parentTaskId) {
      return [...byKey.values()]
        .filter((call) => call.projectId === projectId && call.task.parentTaskId === parentTaskId)
        .map((call) => call.task);
    }
  };
}

async function world() {
  const w = inMemoryDeps();
  const project = await createProjectUseCase(w.deps, { name: 'Demo' });
  assert.ok(project.ok);
  const taskCreations = fakeCreations(w.deps.tasks);
  const deps = { projects: w.deps.projects, tasks: w.deps.tasks, taskCreations, now: w.deps.now };
  return { w, project: project.value, taskCreations, deps };
}

const base = (projectId: string) => ({
  actorId: 'u1',
  sourceSessionId: 's1',
  projectId,
  requestKey: 'req-1',
  title: '子任务'
});

test('同键同参回放第一次结果；任务只建一次', async () => {
  const { w, project, deps } = await world();
  const first = await createTaskWithReplayUseCase(deps, base(project.id));
  assert.ok(first.ok);
  const second = await createTaskWithReplayUseCase(deps, base(project.id));
  assert.ok(second.ok);
  assert.equal(second.value.id, first.value.id);
  assert.equal((await w.deps.tasks.listByProject(project.id)).length, 1);
  assert.equal(deps.taskCreations.calls.length, 2);
});

test('同键换参数：conflict，不覆盖第一次结果', async () => {
  const { w, project, deps } = await world();
  const first = await createTaskWithReplayUseCase(deps, base(project.id));
  assert.ok(first.ok);
  const changed = await createTaskWithReplayUseCase(deps, { ...base(project.id), title: '另一个任务' });
  assert.ok(!changed.ok);
  assert.equal(changed.error.code, 'conflict');
  const tasks = await w.deps.tasks.listByProject(project.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.title, '子任务');
});

test('不同来源会话不共用请求键', async () => {
  const { w, project, deps } = await world();
  const a = await createTaskWithReplayUseCase(deps, base(project.id));
  assert.ok(a.ok);
  const b = await createTaskWithReplayUseCase(deps, { ...base(project.id), sourceSessionId: 's2' });
  assert.ok(b.ok);
  assert.notEqual(b.value.id, a.value.id);
  assert.equal((await w.deps.tasks.listByProject(project.id)).length, 2);
});

test('请求键绑定人 / 会话 / 项目 / 操作，而不是 token', async () => {
  const { project, deps } = await world();
  const result = await createTaskWithReplayUseCase(deps, base(project.id));
  assert.ok(result.ok);
  const call = deps.taskCreations.calls[0]!;
  assert.equal(call.actorId, 'u1');
  assert.equal(call.sourceSessionId, 's1');
  assert.equal(call.projectId, project.id);
  assert.equal(call.operation, TASK_CREATE_OPERATION);
  // 键里没有可伪造的 token / 短期凭据字段。
  assert.ok(!call.key.includes('token'));
});

test('父任务同项目：关系只写子任务，父任务不被修改', async () => {
  const { w, project, deps } = await world();
  const parent = await createTaskUseCase(w.deps, { projectId: project.id, title: '父任务' });
  assert.ok(parent.ok);
  const child = await createTaskWithReplayUseCase(deps, {
    ...base(project.id),
    requestKey: 'req-child',
    title: '子任务',
    parentTaskId: parent.value.id
  });
  assert.ok(child.ok);
  assert.equal(child.value.parentTaskId, parent.value.id);
  const storedParent = await w.deps.tasks.byId(parent.value.id);
  assert.equal(storedParent?.parentTaskId, null);
  const children = await deps.taskCreations.listByParent(project.id, parent.value.id);
  assert.deepEqual(children.map((task) => task.id), [child.value.id]);
});

test('父任务不存在 / 跨项目：拒绝，且不写回执、不建任务', async () => {
  const { w, project, deps } = await world();
  const missing = await createTaskWithReplayUseCase(deps, { ...base(project.id), parentTaskId: 'ghost' });
  assert.ok(!missing.ok);
  assert.equal(missing.error.code, 'not_found');

  const other = await createProjectUseCase(w.deps, { name: 'Other' });
  assert.ok(other.ok);
  const foreignParent = await createTaskUseCase(w.deps, { projectId: other.value.id, title: '别项目父任务' });
  assert.ok(foreignParent.ok);
  const cross = await createTaskWithReplayUseCase(deps, {
    ...base(project.id),
    parentTaskId: foreignParent.value.id
  });
  assert.ok(!cross.ok);
  assert.equal(cross.error.code, 'invalid');
  assert.equal(deps.taskCreations.calls.length, 0);
  assert.equal((await w.deps.tasks.listByProject(project.id)).length, 0);
});

test('创建任务没有隐式副作用：不建会话、不派工', async () => {
  const { w, project, deps } = await world();
  const result = await createTaskWithReplayUseCase(deps, base(project.id));
  assert.ok(result.ok);
  // 只有刚才显式创建的项目，没有任何会话 / 工作空间；派工队列也保持空。
  assert.deepEqual(await w.deps.sessions.listByProject(project.id), []);
  assert.deepEqual(await w.deps.workspaces.byProject(project.id), []);
  assert.deepEqual(w.dispatched, []);
});

test('归档准入：直接父任务已归档 → conflict，不建子任务、不写回执', async () => {
  const { w, project, deps } = await world();
  const parent = await createTaskUseCase(w.deps, { projectId: project.id, title: '父任务' });
  assert.ok(parent.ok);
  assert.equal(await w.deps.tasks.setArchived(parent.value.id, 99, null), true);

  const child = await createTaskWithReplayUseCase(deps, {
    ...base(project.id),
    parentTaskId: parent.value.id
  });
  assert.ok(!child.ok);
  assert.equal(child.error.code, 'conflict');
  assert.match(child.error.message, /已归档/);
  assert.equal(deps.taskCreations.calls.length, 0);
  assert.equal((await w.deps.tasks.listByProject(project.id)).length, 1);
});

test('归档准入：只共享直接父任务，兄弟与祖先归档都不影响', async () => {
  const { w, project, deps } = await world();
  const grandparent = await createTaskUseCase(w.deps, { projectId: project.id, title: '曾祖任务' });
  assert.ok(grandparent.ok);
  assert.equal(await w.deps.tasks.setArchived(grandparent.value.id, 99, null), true);
  const createdParent = createTask({
    projectId: project.id,
    title: '父任务',
    parentTaskId: grandparent.value.id,
    parent: grandparent.value,
    now: w.deps.now()
  });
  assert.ok(createdParent.ok);
  await w.deps.tasks.save(createdParent.value);
  const parent = createdParent;
  const sibling = await createTaskUseCase(w.deps, { projectId: project.id, title: '兄弟任务' });
  assert.ok(sibling.ok);
  assert.equal(await w.deps.tasks.setArchived(sibling.value.id, 99, null), true);

  const child = await createTaskWithReplayUseCase(deps, {
    ...base(project.id),
    parentTaskId: parent.value.id
  });
  assert.ok(child.ok, JSON.stringify(child));
  assert.equal(child.value.parentTaskId, parent.value.id);
  assert.equal(deps.taskCreations.calls.length, 1);
});
