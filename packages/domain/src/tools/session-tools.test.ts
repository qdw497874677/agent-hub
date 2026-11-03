import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from '../use-cases/projects.ts';
import { createTaskUseCase } from '../use-cases/tasks.ts';
import { deriveSessionUseCase, recordEvent } from '../use-cases/sessions.ts';
import type { ToolGrant } from '../tool.ts';
import { createSessionToolProvider } from './session-tools.ts';

const fake: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: {
    prompt: { state: 'available' }, interrupt: { state: 'available' }, fork: { state: 'available' }, resume: { state: 'available' },
    tool_calls: { state: 'available' }, artifacts: { state: 'available' }, structured_events: { state: 'available' }, attachments: { state: 'available' }
  },
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

async function world() {
  const w = inMemoryDeps();
  w.agents.push(fake);
  const mk = async (name: string) => {
    const project = await createProjectUseCase(w.deps, { name, rootPath: `/tmp/${name}` });
    assert.ok(project.ok);
    const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't', ownerId: 'u1' });
    assert.ok(task.ok);
    const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
    assert.ok(session.ok);
    return { task: task.value, session: session.value };
  };
  const a = await mk('a');
  const b = await mk('b');
  const a2 = await deriveSessionUseCase(w.deps, { taskId: a.task.id, agentId: 'fake', model: 'm1' });
  assert.ok(a2.ok);
  for (let i = 1; i <= 5; i++) {
    await recordEvent(w.deps, { sessionId: a.session.id, event: { kind: 'prompt', text: `问${i}` } });
    await recordEvent(w.deps, { sessionId: a.session.id, event: { kind: 'text', delta: `答${i}`.repeat(i === 5 ? 3000 : 1) } });
  }
  const grant = (sessionId: string, taskId: string) => ({ grant: { sessionId, taskId, scopes: ['context'] } as unknown as ToolGrant, now: 0 });
  return { w, a, b, a2: a2.value, grant, tools: createSessionToolProvider(w.deps) };
}

test('session.read：同项目能分页读原文，标 untrusted', async () => {
  const { a, a2, grant, tools } = await world();
  const page = await tools.call('session.read', { session_id: a.session.id, limit: 4 }, grant(a2.id, a2.taskId));
  assert.ok(page.ok, JSON.stringify(page));
  const v = page.value as { trust: string; items: { text: string; seq: number }[]; next_after_seq: number | null; total_items: number };
  assert.equal(v.trust, 'untrusted');
  assert.equal(v.items.length, 4);
  assert.equal(v.items[0]!.text, '用户：问1');
  assert.equal(v.total_items, 10);
  assert.ok(v.next_after_seq);
  const next = await tools.call('session.read', { session_id: a.session.id, after_seq: v.next_after_seq, limit: 20, max_chars_per_item: 500 }, grant(a2.id, a2.taskId));
  assert.ok(next.ok);
  const n = next.value as { items: { text: string; seq: number; truncated?: boolean; next_text_offset?: number }[]; next_after_seq: number | null };
  assert.equal(n.items[0]!.text, '用户：问3');
  assert.equal(n.next_after_seq, null);
  const long = n.items.at(-1)!;
  assert.ok(long.truncated && long.next_text_offset === 500);
  const more = await tools.call('session.read', { session_id: a.session.id, item_seq: long.seq, text_offset: 500, max_chars_per_item: 500 }, grant(a2.id, a2.taskId));
  assert.ok(more.ok);
  assert.match((more.value as { items: { text: string }[] }).items[0]!.text, /5答5/);
});

test('session.read：别的项目、不存在的会话一律读不了', async () => {
  const { a, b, grant, tools } = await world();
  const other = await tools.call('session.read', { session_id: a.session.id }, grant(b.session.id, b.task.id));
  assert.ok(!other.ok && other.error.code === 'forbidden');
  const missing = await tools.call('session.read', { session_id: 'nope' }, grant(b.session.id, b.task.id));
  assert.ok(!missing.ok && missing.error.code === 'forbidden');
});
