import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import { createProjectUseCase, createTaskUseCase } from '@agent-hub/domain';
import { workspaceForApiStart } from './session-workspace.ts';

async function world(repoUrl?: string) {
  const w = inMemoryDeps();
  w.workers.push({ workerId: 'remote-1', label: '远程', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  const project = await createProjectUseCase(w.deps, { name: 'Demo App', ...(repoUrl ? { repoUrl } : {}) });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 'Fix login' });
  assert.ok(task.ok);
  return { ...w, project: project.value, task: task.value };
}

test('开放 API 建会话：项目没有长期工作空间时现建一个临时空间，别再回「没有工作空间」', async () => {
  const w = await world();
  const placed = await workspaceForApiStart(w.deps, { taskId: w.task.id, workerId: 'remote-1' }, null);
  assert.ok(placed.ok, placed.ok ? '' : placed.error.message);
  assert.ok(placed.value, '应该建出一个工作空间');
  const made = await w.deps.workspaces.byId(placed.value as never);
  assert.equal(made?.kind, 'temporary');
  assert.equal(made?.ownerTaskId, w.task.id);
  assert.equal(made?.workerId, 'remote-1');
});

test('已经有长期工作空间时沿用默认，不额外建目录', async () => {
  const w = await world();
  const { prepareLongLivedWorkspaceUseCase } = await import('@agent-hub/domain');
  const long = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'remote-1', plan: { mode: 'create' }, home: '/home/me' });
  assert.ok(long.ok);
  const placed = await workspaceForApiStart(w.deps, { taskId: w.task.id, workerId: 'remote-1' }, null);
  assert.ok(placed.ok);
  assert.equal(placed.value, null);
});

test('调用方指定了 workspaceId 或组合工作空间：原样放行', async () => {
  const w = await world();
  const a = await workspaceForApiStart(w.deps, { taskId: w.task.id, workspaceId: 'ws-1' }, null);
  assert.ok(a.ok);
  assert.equal(a.value, null);
  const b = await workspaceForApiStart(w.deps, { taskId: w.task.id, groupId: 'grp-1' }, null);
  assert.ok(b.ok);
  assert.equal(b.value, null);
});

test('容器会话（没有 taskId）不建工作空间，交给 derive 自己判断', async () => {
  const w = await world();
  const placed = await workspaceForApiStart(w.deps, {}, null);
  assert.ok(placed.ok);
  assert.equal(placed.value, null);
});
