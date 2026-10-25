import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from './testing/in-memory.ts';
import { asAgentId } from './ids.ts';
import { taskBriefing, BRIEFING_MAX_BYTES } from './task-briefing.ts';
import { createProjectUseCase } from './use-cases/projects.ts';
import { createTaskUseCase } from './use-cases/tasks.ts';
import { deriveSessionUseCase } from './use-cases/sessions.ts';
import { promptSessionUseCase } from './use-cases/conversation.ts';
import { appendWorkLogUseCase } from './use-cases/work-log.ts';
import type { AgentDescriptor } from './agent.ts';
import type { Task } from './task.ts';

const task = (over: Partial<Task> = {}) => ({ id: 't', title: '接 MCP', goal: null, summary: null, ...over }) as Task;

test('taskBriefing：没内容不垫；有交接带上；超长截到 4KB 内', () => {
  assert.equal(taskBriefing(task(), null), null);
  const b = taskBriefing(task({ goal: '让 agent 写日志' }), { seq: 3, body: '## 下一步\n- 接 UI' } as never);
  assert.match(b ?? '', /目标：让 agent 写日志/);
  assert.match(b ?? '', /最近交接（#3）/);
  const long = taskBriefing(task({ summary: '摘'.repeat(5000) }), { seq: 9, body: '交'.repeat(5000) } as never) ?? '';
  assert.ok(new TextEncoder().encode(long).length <= BRIEFING_MAX_BYTES, `got ${long.length}`);
  assert.match(long, /最近交接/);
});

test('新会话第一句给 agent 垫背景，journal 里仍是原话；第二句不垫', async () => {
  const w = inMemoryDeps();
  w.agents.push({ id: asAgentId('fake'), label: 'F', capabilities: Object.fromEntries(['prompt','interrupt','fork','resume','tool_calls','artifacts','structured_events','attachments'].map((k) => [k, { state: 'available' }])), models: ['m'], defaultModel: 'm', options: [] } as unknown as AgentDescriptor);
  const project = await createProjectUseCase(w.deps, { name: 'p', rootPath: '/tmp/p' });
  assert.ok(project.ok);
  const t = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '接 MCP', goal: '写交接', ownerId: 'u' });
  assert.ok(t.ok);
  await appendWorkLogUseCase(w.deps, { taskId: t.value.id, kind: 'handoff', body: '上一位：做完 P2', author: { kind: 'user', userId: 'u' } } as never);
  const s = await deriveSessionUseCase(w.deps, { taskId: t.value.id, agentId: 'fake', model: 'm' });
  assert.ok(s.ok);
  assert.ok((await promptSessionUseCase(w.deps, { sessionId: s.value.id, text: '开工' })).ok);
  const first = w.dispatched.filter((c) => c.kind === 'prompt').at(-1) as { text: string };
  assert.match(first.text, /上一位：做完 P2/);
  assert.match(first.text, /开工$/);
  assert.ok((await promptSessionUseCase(w.deps, { sessionId: s.value.id, text: '继续' })).ok);
  assert.equal((w.dispatched.filter((c) => c.kind === 'prompt').at(-1) as { text: string }).text, '继续');
});
