import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase, recordEvent } from './sessions.ts';
import { loadCanvas } from './canvas.ts';

const agent: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: {
    prompt: { state: 'available' },
    interrupt: { state: 'available' },
    fork: { state: 'available' },
    resume: { state: 'available' },
    tool_calls: { state: 'available' },
    artifacts: { state: 'available' },
    structured_events: { state: 'available' },
    attachments: { state: 'available' }
  },
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

test('画布：第一句话留在 openings，最近 24 条预览装不下它也还在', async () => {
  const w = inMemoryDeps();
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '同名任务' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  await recordEvent(w.deps, { sessionId: session.value.id, event: { kind: 'prompt', text: '第一条会话：看看日志' } });
  for (let i = 0; i < 30; i++) await recordEvent(w.deps, { sessionId: session.value.id, event: { kind: 'tool_call', name: 'bash', input: String(i) } });
  const canvas = await loadCanvas(w.deps, project.value.id);
  assert.ok(canvas.ok);
  assert.equal(canvas.value.openings[session.value.id], '第一条会话：看看日志');
  assert.equal(canvas.value.previews[session.value.id]?.some((entry) => entry.event.kind === 'prompt'), false);
  assert.equal(canvas.value.previews[session.value.id]?.length, 24);
});
