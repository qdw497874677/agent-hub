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

const entry = (seq: number, body: string, author: object = { kind: 'agent', agentId: 'grok', model: 'g', sessionId: 's' }) =>
  ({ seq, body, author }) as never;

test('taskBriefing：没内容不垫；最新人/agent 日志放全文，系统和更早的压成一行；超长截到 4KB 内', () => {
  assert.equal(taskBriefing(task(), []), null);
  const b = taskBriefing(task({ goal: '让 agent 写日志' }), [
    entry(5, '会话结束', { kind: 'system' }),
    entry(4, '## 下一步\n- 接 UI'),
    entry(2, '先看了代码', { kind: 'user', userId: 'u', name: 'David' })
  ]) ?? '';
  assert.match(b, /目标：让 agent 写日志/);
  assert.match(b, /最新日志（#4，grok·g）：\n## 下一步/);
  assert.match(b, /- #2 David：先看了代码\n- #5 系统：会话结束/);
  assert.doesNotMatch(b, /kind=/);
  const long = taskBriefing(task({ summary: '摘'.repeat(5000) }), [entry(9, '交'.repeat(5000)), entry(8, '早'.repeat(5000))]) ?? '';
  assert.ok(new TextEncoder().encode(long).length <= BRIEFING_MAX_BYTES, `got ${long.length}`);
  assert.match(long, /最新日志/);
});

test('新会话第一句给 agent 垫背景，journal 里仍是原话；第二句不垫', async () => {
  const w = inMemoryDeps();
  w.agents.push({ id: asAgentId('fake'), label: 'F', capabilities: Object.fromEntries(['prompt','interrupt','fork','resume','tool_calls','artifacts','structured_events','attachments'].map((k) => [k, { state: 'available' }])), models: ['m'], defaultModel: 'm', options: [] } as unknown as AgentDescriptor);
  const project = await createProjectUseCase(w.deps, { name: 'p', rootPath: '/tmp/p' });
  assert.ok(project.ok);
  const t = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '接 MCP', goal: '写交接', ownerId: 'u' });
  assert.ok(t.ok);
  await appendWorkLogUseCase(w.deps, { taskId: t.value.id, body: '上一位：做完 P2', author: { kind: 'user', userId: 'u' } } as never);
  const s = await deriveSessionUseCase(w.deps, { taskId: t.value.id, agentId: 'fake', model: 'm' });
  assert.ok(s.ok);
  assert.ok((await promptSessionUseCase(w.deps, { sessionId: s.value.id, text: '开工' })).ok);
  const first = w.dispatched.filter((c) => c.kind === 'prompt').at(-1) as { text: string };
  assert.match(first.text, /上一位：做完 P2/);
  assert.match(first.text, /开工$/);
  assert.ok((await promptSessionUseCase(w.deps, { sessionId: s.value.id, text: '继续' })).ok);
  assert.equal((w.dispatched.filter((c) => c.kind === 'prompt').at(-1) as { text: string }).text, '继续');
});

test('taskBriefing：项目说明和仓库原样交给 agent（没 git 仓库也照样有说明）', () => {
  const withDoc = taskBriefing(task(), [], { name: 'Demo', repoUrl: null, description: '代码在 git@example.com:me/demo.git，部署用 make deploy' }) ?? '';
  assert.match(withDoc, /项目：Demo/);
  assert.match(withDoc, /git@example\.com:me\/demo\.git/);
  assert.doesNotMatch(withDoc, /仓库：/);
  const withRepo = taskBriefing(task(), [], { name: 'Demo', repoUrl: 'https://x/y.git', description: null }) ?? '';
  assert.match(withRepo, /仓库：https:\/\/x\/y\.git/);
  assert.equal(taskBriefing(task(), [], { name: 'Demo', repoUrl: null, description: null }), null);
});

test('bot 会话：职责说明只在新会话第一句垫一次（放最前），续聊 / resume 不重复；用户看到的仍是原话', async () => {
  const w = inMemoryDeps();
  w.agents.push({ id: asAgentId('fake'), label: 'F', capabilities: Object.fromEntries(['prompt','interrupt','fork','resume','tool_calls','artifacts','structured_events','attachments'].map((k) => [k, { state: 'available' }])), models: ['m'], defaultModel: 'm', options: [] } as unknown as AgentDescriptor);
  const project = await createProjectUseCase(w.deps, { name: 'p', rootPath: '/tmp/p' });
  assert.ok(project.ok);
  const t = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 'x', ownerId: 'u' });
  assert.ok(t.ok);
  const s = await deriveSessionUseCase(w.deps, { taskId: t.value.id, agentId: 'fake', model: 'm' });
  assert.ok(s.ok);
  const asked: string[] = [];
  const deps = { ...w.deps, sessionInstructions: async (id: string) => (asked.push(id), id === s.value.id ? '<agent-instructions>\n只写测试\n</agent-instructions>' : null) };
  assert.ok((await promptSessionUseCase(deps, { sessionId: s.value.id, text: '开工' })).ok);
  const first = w.dispatched.filter((c) => c.kind === 'prompt').at(-1) as { text: string };
  assert.ok(first.text.startsWith('<agent-instructions>\n只写测试\n</agent-instructions>'));
  assert.match(first.text, /开工$/);
  const journal = await w.deps.sessions.eventsAfter(s.value.id, 0 as never);
  assert.ok(journal.some((e) => e.event.kind === 'prompt' && e.event.text === '开工'));
  assert.ok((await promptSessionUseCase(deps, { sessionId: s.value.id, text: '继续' })).ok);
  assert.equal((w.dispatched.filter((c) => c.kind === 'prompt').at(-1) as { text: string }).text, '继续');
  assert.equal(asked.length, 1);
  // 解析失败不挡消息
  const s2 = await deriveSessionUseCase(w.deps, { taskId: t.value.id, agentId: 'fake', model: 'm' });
  assert.ok(s2.ok);
  assert.ok((await promptSessionUseCase({ ...w.deps, sessionInstructions: async () => { throw new Error('x'); } }, { sessionId: s2.value.id, text: 'hi' })).ok);
});
