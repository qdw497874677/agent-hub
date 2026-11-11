import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asAgentId } from '@agent-hub/domain';
import { createProjectUseCase, createTaskUseCase, deriveSession } from '@agent-hub/domain';
import { inMemoryAssets, inMemoryDeps } from '@agent-hub/domain/testing';
import { createSessionEnvironment } from './session-environment.ts';

test('会话环境版本：同一套资产/机器给出稳定哈希', async () => {
  const assets = inMemoryAssets();
  const world = inMemoryDeps();
  const project = await createProjectUseCase(world.deps, { name: 'env', rootPath: '/tmp/env' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(world.deps, { projectId: project.value.id, title: '环境' });
  assert.ok(task.ok);
  const made = deriveSession({
    task: task.value,
    agentId: asAgentId('fake'),
    model: '',
    now: 1,
    workerId: 'w1'
  });
  assert.ok(made.ok);

  const environment = createSessionEnvironment({
    assetDeps: { ...assets.deps, projects: world.deps.projects },
    tasks: world.deps.tasks,
    projects: world.deps.projects
  });

  const first = await environment.revision(made.value);
  const second = await environment.revision(made.value);
  assert.ok(first);
  assert.equal(first, second);
});
