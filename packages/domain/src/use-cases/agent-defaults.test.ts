import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase, setProjectDefaultAgentUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import type { Project } from '../project.ts';
import { asAgentId } from '../ids.ts';
import { newWorkspace } from '../workspace.ts';
import type { AgentDescriptor } from '../agent.ts';

/**
 * 团队级运行时默认模型：新会话没点名模型时按运行时补；会话显式选的永远优先。
 * 它只在 `ref.model === ''` 时生效——「没说」和「说了空」是同一件事，但说了别的就不能被改。
 */
async function world(teamId: string | null = 't1', defaults: Record<string, string> = { fake: 'team-default' }) {
  const w = inMemoryDeps();
  const fake: AgentDescriptor = {
    id: asAgentId('fake'),
    label: 'Fake',
    capabilities: Object.fromEntries(
      ['prompt', 'interrupt', 'fork', 'resume', 'tool_calls', 'artifacts', 'structured_events', 'attachments'].map((key) => [key, { state: 'available' }])
    ) as AgentDescriptor['capabilities'],
    models: ['m1'],
    defaultModel: 'm1',
    options: []
  };
  w.agents.push(fake);
  const made = await createProjectUseCase(w.deps, { name: 'p', rootPath: '/tmp/p' });
  assert.ok(made.ok);
  const project: Project = { ...made.value, teamId };
  await w.deps.projects.save(project);
  const workspace = newWorkspace({ projectId: project.id, workerId: null, path: '/tmp/p', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await w.deps.workspaces.save(workspace.value);
  const task = await createTaskUseCase(w.deps, { projectId: project.id, title: 't' });
  assert.ok(task.ok);
  const saved = new Map<string, Record<string, string>>(teamId === null ? [] : [[teamId, defaults]]);
  const agentDefaults = {
    async forTeam(id: string) {
      return saved.get(id) ?? {};
    },
    async save(id: string, value: Record<string, string>) {
      saved.set(id, { ...value });
    }
  };
  return { ...w, task: task.value, project, deps: { ...w.deps, agentDefaults } };
}

test('没点名模型时用团队的运行时默认', async () => {
  const w = await world();
  const made = await deriveSessionUseCase(w.deps, { taskId: w.task.id, agentId: 'fake', model: '' });
  assert.ok(made.ok, JSON.stringify(made));
  assert.equal(made.value.model, 'team-default');
});

test('会话明确选的模型不会被团队默认覆盖', async () => {
  const w = await world();
  const made = await deriveSessionUseCase(w.deps, { taskId: w.task.id, agentId: 'fake', model: 'explicit' });
  assert.ok(made.ok);
  assert.equal(made.value.model, 'explicit');
});

test('团队没配这个运行时、或项目不属于团队时保持空串（交给 agent 自己的默认）', async () => {
  const missing = await world('t1', { opencode: 'whatever' });
  const other = await deriveSessionUseCase(missing.deps, { taskId: missing.task.id, agentId: 'fake', model: '' });
  assert.ok(other.ok, JSON.stringify(other));
  assert.equal(other.value.model, '');

  const loose = await world(null);
  const made = await deriveSessionUseCase(loose.deps, { taskId: loose.task.id, agentId: 'fake', model: '' });
  assert.ok(made.ok);
  assert.equal(made.value.model, '');
});

test('项目默认 Agent：补 runtime / 模型 / 选项；任务上的默认覆盖项目；显式选择最高', async () => {
  const w = await world('t1', {});
  const withProject: Project = {
    ...w.project,
    defaultAgent: { runtime: 'fake', model: 'project-model', options: { effort: 'medium', thinking: true } }
  };
  await w.deps.projects.save(withProject);
  const fromProject = await deriveSessionUseCase(w.deps, { taskId: w.task.id });
  assert.ok(fromProject.ok, JSON.stringify(fromProject));
  assert.equal(fromProject.value.model, 'project-model');
  assert.equal(fromProject.value.options['effort'], 'medium');

  const task = await w.deps.tasks.byId(w.task.id);
  assert.ok(task !== null);
  await w.deps.tasks.save({ ...task, defaultAgent: { runtime: 'fake', model: 'task-model', options: { effort: 'high' } } });
  const fromTask = await deriveSessionUseCase(w.deps, { taskId: w.task.id });
  assert.ok(fromTask.ok);
  assert.equal(fromTask.value.model, 'task-model');
  assert.equal(fromTask.value.options['effort'], 'high');
  // 任务没写的选项仍然由项目铺进来
  assert.equal(fromTask.value.options['thinking'], true);

  const explicit = await deriveSessionUseCase(w.deps, { taskId: w.task.id, agentId: 'fake', model: 'mine', options: { effort: 'low' } });
  assert.ok(explicit.ok);
  assert.equal(explicit.value.model, 'mine');
  assert.equal(explicit.value.options['effort'], 'low');
});

test('项目 / 任务默认里的坏值在保存时就被拦住', async () => {
  const w = await world('t1', {});
  const bad = await setProjectDefaultAgentUseCase(w.deps, { projectId: w.project.id, defaultAgent: { runtime: '', model: 'x', options: {} } });
  assert.ok(!bad.ok);
  const okAgent = await setProjectDefaultAgentUseCase(w.deps, {
    projectId: w.project.id,
    defaultAgent: { runtime: 'fake', model: '', options: { effort: 'medium' } }
  });
  assert.ok(okAgent.ok);
  assert.deepEqual(okAgent.value.defaultAgent, { runtime: 'fake', model: '', options: { effort: 'medium' } });
});
