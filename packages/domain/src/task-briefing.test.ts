import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from './testing/in-memory.ts';
import { asAgentId, asWorkspaceId } from './ids.ts';
import { taskBriefing, BRIEFING_MAX_BYTES } from './task-briefing.ts';
import { createProjectUseCase } from './use-cases/projects.ts';
import { createTaskUseCase } from './use-cases/tasks.ts';
import { deriveSessionUseCase } from './use-cases/sessions.ts';
import { promptSessionUseCase } from './use-cases/conversation.ts';
import { appendWorkLogUseCase } from './use-cases/work-log.ts';
import type { AgentDescriptor } from './agent.ts';
import type { Task } from './task.ts';
import { inMemoryDeliveries } from './testing/in-memory.ts';
import { ok } from './result.ts';

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

test('planned local single briefing describes the output cwd, not the project repo or source metadata', async () => {
  const w = inMemoryDeps({ deliveries: inMemoryDeliveries() });
  w.agents.push({ id: asAgentId('fake'), label: 'F', capabilities: Object.fromEntries(['prompt','interrupt','fork','resume','tool_calls','artifacts','structured_events','attachments'].map((k) => [k, { state: 'available' }])), models: ['m'], defaultModel: 'm', options: [] } as unknown as AgentDescriptor);
  const project = await createProjectUseCase(w.deps, { name: 'p', rootPath: '/tmp/p', repoUrl: 'https://example.com/project-a.git', description: 'Keep this project description.' });
  assert.ok(project.ok);
  const t = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 'task' });
  assert.ok(t.ok);
  const s = await deriveSessionUseCase(w.deps, { taskId: t.value.id, agentId: 'fake', model: 'm' });
  assert.ok(s.ok);
  const sessionId = s.value.id;
  const outputId = asWorkspaceId('local-output');
  let source: 'local' | 'project' | null = 'local';
  const deps = {
    ...w.deps,
    sessions: { ...w.deps.sessions, byId: async (id: typeof sessionId) => {
      const session = await w.deps.sessions.byId(id);
      return session ? { ...session, workspaceId: outputId } : null;
    } },
    plannedWorktreeGuard: {
      isWorkspaceProtected: () => false, isGroupProtected: () => false, noteStarted: () => {},
      forOutput: (id: string) => id === outputId && source ? { source, state: 'closed' as const, groupId: null } : null
    }
  };
  async function briefing(): Promise<string> {
    let text = '';
    const result = await promptSessionUseCase(deps, { sessionId, text: 'hello' }, async ({ payload }) => {
      assert.ok(typeof payload === 'object' && payload !== null && 'text' in payload && typeof payload.text === 'string');
      text = payload.text;
      return ok({ ack: { seq: 1, deliveryId: 'd', state: 'queued', turn: 1 }, publishedSession: null });
    });
    assert.ok(result.ok);
    return text;
  }
  const local = await briefing();
  assert.match(local, /当前工作目录（\.）是本地仓库的工作目录/);
  assert.match(local, /项目说明：\nKeep this project description\./);
  assert.doesNotMatch(local, /project-a\.git|\/tmp\/p|common-dir|credentials/);
  source = 'project';
  assert.match(await briefing(), /仓库：https:\/\/example\.com\/project-a\.git/);
  source = null;
  assert.match(await briefing(), /仓库：https:\/\/example\.com\/project-a\.git/);
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

test('taskBriefing：组合工作目录写出容器根和每个成员仓库', () => {
  const text = taskBriefing(task(), [], {
    name: 'Demo',
    repoUrl: null,
    description: null,
    workspaceRoot: '/srv/groups/demo/x1',
    repos: [
      { name: 'web', path: '/srv/groups/demo/x1/web', url: 'https://example.com/web.git', branch: 'feat/a' },
      { name: 'api', path: '/srv/groups/demo/x1/api', url: 'https://example.com/api.git', branch: 'main' }
    ]
  }) ?? '';
  assert.match(text, /组合工作目录：\/srv\/groups\/demo\/x1/);
  assert.match(text, /- web  \/srv\/groups\/demo\/x1\/web  分支 feat\/a  https:\/\/example.com\/web.git/);
  assert.match(text, /- api  \/srv\/groups\/demo\/x1\/api  分支 main  https:\/\/example.com\/api.git/);
  assert.match(text, /按仓库分别进行/);
});

test('taskBriefing：amp 布局用相对路径，标明主仓库', () => {
  const text = taskBriefing(task(), [], {
    name: 'Demo',
    repoUrl: null,
    description: null,
    workspaceRoot: '/srv/groups/demo/x1/web',
    groupLayout: 'amp',
    repos: [
      { name: 'web', path: '/srv/groups/demo/x1/web', relativePath: '.', url: 'https://example.com/web.git', branch: 'feat/a', primary: true },
      { name: 'api', path: '/srv/groups/demo/x1/repos/api', relativePath: '../repos/api', url: 'https://example.com/api.git', branch: 'main' }
    ]
  }) ?? '';
  assert.match(text, /组合工作目录：\/srv\/groups\/demo\/x1\/web/);
  assert.match(text, /- web  \.  主仓库  分支 feat\/a/);
  assert.match(text, /- api  \.\.\/repos\/api  分支 main/);
  assert.match(text, /工作目录是主仓库/);
});
