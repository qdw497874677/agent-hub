import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asAgentId,
  createProject,
  createTask,
  deriveSession,
  type Bot,
  type Session
} from '@agent-hub/domain';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import { createBotOfSession } from './bot-session.ts';

const now = 1_700_000_000_000;

async function world() {
  const w = inMemoryDeps();
  const project = createProject({ name: 'demo', now });
  assert.ok(project.ok);
  const task = createTask({ projectId: project.value.id, title: 't', goal: 'g', now });
  assert.ok(task.ok);
  await w.deps.projects.save(project.value);
  await w.deps.tasks.save(task.value);
  const bot: Bot = {
    id: 'bot_0123456789abcdef',
    teamId: project.value.teamId ?? 'team_legacy',
    name: 'host',
    description: '主持',
    ref: { runtime: 'pi', model: 'm', options: {} },
    reuse: 'sticky',
    createdAt: 1,
    updatedAt: 1
  };
  await w.deps.bots.save(bot);
  const session = async (botId?: string | null): Promise<Session> => {
    const derived = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now, ...(botId !== undefined ? { botId } : {}) });
    assert.ok(derived.ok);
    await w.deps.sessions.save(derived.value);
    return derived.value;
  };
  return { w, project: project.value, task: task.value, bot, session };
}

test('新会话按 botId 解析；派生记录里是不同的名字也不会串（#221）', async () => {
  const { w, project, bot, session } = await world();
  const s = await session(bot.id);
  const resolve = createBotOfSession({
    sessions: w.deps.sessions,
    tasks: w.deps.tasks,
    bots: w.deps.bots,
    // 故意给一个别的角色名：新会话必须信 bot_id，而不是名字
    spawnOf: async () => ({ role: 'coder' }),
    memberOfSession: async () => ({ role: 'coder' })
  });
  assert.deepEqual(await resolve(s.id), { projectId: project.id, name: 'host', botId: bot.id });
});

test('bot 被删后，持有它 botId 的会话不再解析成 bot', async () => {
  const { w, session, bot } = await world();
  const s = await session(bot.id);
  await w.deps.bots.remove(bot.id);
  const resolve = createBotOfSession({
    sessions: w.deps.sessions,
    tasks: w.deps.tasks,
    bots: w.deps.bots,
    spawnOf: async () => ({ role: 'host' }),
    memberOfSession: async () => null
  });
  assert.equal(await resolve(s.id), null);
  // 即使之后建了别的 bot，旧会话也不会指到它
  await w.deps.bots.save({ ...bot, id: 'bot_ffffffffffffffff', name: 'coder' });
  assert.equal(await resolve(s.id), null);
});

test('老会话没有 botId：回落按派生记录 / 群成员里的名字反查', async () => {
  const { w, project, bot, session } = await world();
  const s = await session();
  const spawnResolve = createBotOfSession({
    sessions: w.deps.sessions,
    tasks: w.deps.tasks,
    bots: w.deps.bots,
    spawnOf: async () => ({ role: 'host' }),
    memberOfSession: async () => null
  });
  assert.deepEqual(await spawnResolve(s.id), { projectId: project.id, name: 'host', botId: bot.id });

  const memberResolve = createBotOfSession({
    sessions: w.deps.sessions,
    tasks: w.deps.tasks,
    bots: w.deps.bots,
    spawnOf: async () => null,
    memberOfSession: async () => ({ role: 'host' })
  });
  assert.deepEqual(await memberResolve(s.id), { projectId: project.id, name: 'host', botId: bot.id });

  // 两种老记录都没有 = 不是 bot 会话
  const none = createBotOfSession({
    sessions: w.deps.sessions,
    tasks: w.deps.tasks,
    bots: w.deps.bots,
    spawnOf: async () => null,
    memberOfSession: async () => null
  });
  assert.equal(await none(s.id), null);
});

test('老会话反查时 bot 表里没有这个名字：仍按名字归属，botId 为 null', async () => {
  const { w, project, session, bot } = await world();
  const s = await session();
  await w.deps.bots.remove(bot.id);
  const resolve = createBotOfSession({
    sessions: w.deps.sessions,
    tasks: w.deps.tasks,
    bots: w.deps.bots,
    spawnOf: async () => ({ role: 'host' }),
    memberOfSession: async () => null
  });
  assert.deepEqual(await resolve(s.id), { projectId: project.id, name: 'host', botId: null });
});

test('会话不存在 / 任务不存在：返回 null', async () => {
  const { w } = await world();
  const resolve = createBotOfSession({
    sessions: w.deps.sessions,
    tasks: w.deps.tasks,
    bots: w.deps.bots,
    spawnOf: async () => ({ role: 'host' }),
    memberOfSession: async () => null
  });
  assert.equal(await resolve('ses_missing' as never), null);
});
