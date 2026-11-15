import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { asAgentId } from '../ids.ts';
import { available, capabilityMatrix } from '../capability.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { ingestWorkerOptions as reportOptions } from './conversation.ts';

/**
 * 模型留空 = 每次启动由运行时自己决定。
 *
 * 机器上的 opencode 装了插件、或改了配置，默认模型会跟着变。如果 hub 把
 * 「这次启动解析出来的默认值」钉进会话，下次启动就会拿旧值覆盖运行时的真实默认，
 * 机器上换过配置的会话会指向一个莫名其妙的模型（比如额度已尽的免费模型）。
 */
async function world() {
  const w = inMemoryDeps();
  w.agents.push({
    id: asAgentId('fake'),
    label: 'Fake',
    capabilities: capabilityMatrix({
      prompt: available,
      interrupt: available,
      fork: available,
      resume: available,
      tool_calls: available,
      artifacts: available,
      structured_events: available,
      attachments: available
    }),
    models: ['m1', 'm2'],
    defaultModel: 'm1',
    options: []
  });
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: '' });
  assert.ok(session.ok);
  return { deps: w.deps, sid: session.value.id };
}

test('模型留空：agent 回报的默认模型只进 optionSpec，不写进会话', async () => {
  const w = await world();
  const before = await w.deps.sessions.byId(w.sid as never);
  assert.equal(before?.model, '');
  const reported = await reportOptions(w.deps, w.sid as never, [
    { id: 'model', label: 'Model', category: 'model', kind: 'select', current: 'fake/free', choices: [] }
  ]);
  assert.ok(reported.ok, JSON.stringify(reported));
  const after = await w.deps.sessions.byId(w.sid as never);
  assert.equal(after?.model, '', '运行时默认值不钉进会话');
  assert.equal(after?.options['model'], undefined, '也不写进启动选项');
  assert.equal(after?.optionSpec.find((o) => o.id === 'model')?.current, 'fake/free', '界面仍能看到这次实际用的模型');
});

test('用户显式选过模型：之后 agent 的回报照旧同步', async () => {
  const w = await world();
  // 用户显式选择（这里直接走会话记录 + 回报的组合，避免依赖 UI 路径）
  const session = await w.deps.sessions.byId(w.sid as never);
  assert.ok(session);
  await w.deps.sessions.save({ ...session, model: 'm2', options: { ...session.options, model: 'm2' } });
  await reportOptions(w.deps, w.sid as never, [
    { id: 'model', label: 'Model', category: 'model', kind: 'select', current: 'm2', choices: [] }
  ]);
  const after = await w.deps.sessions.byId(w.sid as never);
  assert.equal(after?.options['model'], 'm2');
  assert.equal(after?.model, 'm2');
});
