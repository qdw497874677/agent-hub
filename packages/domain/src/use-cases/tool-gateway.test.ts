import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { createToolGateway } from "./tool-gateway.ts";
import { createTaskToolProvider } from "../tools/task-tools.ts";
import { fakeToolGrants } from "../testing/in-memory.ts";


const fake: AgentDescriptor = {
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

let counter = 0;
const tokens = {
  issue: () => {
    counter += 1;
    return { token: `tok-${counter}`, hash: `h-tok-${counter}` };
  },
  hashOf: (token: string) => `h-${token}`
};

async function world() {
  const w = inMemoryDeps();
  w.agents.push(fake);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '接通能力层', ownerId: 'u1' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  const toolGrants = fakeToolGrants();
  let now = 1_000;
  const gateway = createToolGateway({
    now: () => now,
    toolGrants,
    tokens,
    providers: [createTaskToolProvider(w.deps)]
  });
  return { ...w, task: task.value, session: session.value, gateway, toolGrants, tick: (ms: number) => (now += ms) };
}

test('签发授权：令牌换得到授权；重新签发作废旧的；作废/过期后不认', async () => {
  const w = await world();
  const first = await w.gateway.issue(w.session);
  assert.equal((await w.gateway.authenticate(first.token))?.id, first.grant.id);
  assert.equal(w.toolGrants.grants[0]?.tokenHash.includes(first.token), true, 'fake hash');
  const second = await w.gateway.issue(w.session);
  assert.equal(await w.gateway.authenticate(first.token), null);
  assert.ok(await w.gateway.authenticate(second.token));
  w.tick(13 * 60 * 60 * 1000);
  assert.equal(await w.gateway.authenticate(second.token), null);
  assert.equal(await w.gateway.authenticate(''), null);
});

test('授权短期滑动续期：闲置 1 小时过期；一直在用就续，但签发后最多 12 小时', async () => {
  const w = await world();
  const idle = await w.gateway.issue(w.session);
  w.tick(61 * 60 * 1000);
  assert.equal(await w.gateway.authenticate(idle.token), null, '闲置超过 1 小时即失效');

  const busy = await w.gateway.issue(w.session);
  for (let hour = 0; hour < 11; hour += 1) {
    w.tick(40 * 60 * 1000);
    assert.ok(await w.gateway.authenticate(busy.token), `第 ${hour} 次续期`);
  }
  // 已经过了 7 小时多；再一直用也活不过签发后 12 小时
  for (let i = 0; i < 12; i += 1) {
    w.tick(40 * 60 * 1000);
    await w.gateway.authenticate(busy.token);
  }
  assert.equal(await w.gateway.authenticate(busy.token), null, '超过最长寿命');
});

test('revokeAllExcept：只保留运行中会话的授权（hub 启动时）；传空 = 全部作废', async () => {
  const w = await world();
  const kept = await w.gateway.issue(w.session);
  const other = { ...w.session, id: 'other-session' as typeof w.session.id };
  const stale = await w.gateway.issue(other);
  assert.equal(await w.gateway.revokeAllExcept([w.session.id]), 1);
  assert.ok(await w.gateway.authenticate(kept.token));
  assert.equal(await w.gateway.authenticate(stale.token), null);
  assert.equal(await w.gateway.revokeAllExcept([]), 1);
  assert.equal(await w.gateway.authenticate(kept.token), null);
});

test('task.get / task.log.append / task.log.list：隐式绑定当前任务，agent 署名，写日志刷新 summary', async () => {
  const w = await world();
  const { grant } = await w.gateway.issue(w.session);
  assert.deepEqual(
    w.gateway.list(grant).map((tool) => tool.name),
    ['task.get', 'task.log.list', 'task.log.append', 'task.update_status']
  );
  const appended = await w.gateway.call(grant, 'task.log.append', { body: '## 已完成\n- 接好 MCP\n\n## 下一步\n- 写测试' });
  assert.ok(appended.ok);
  const got = await w.gateway.call(grant, 'task.get', {});
  assert.ok(got.ok);
  const task = got.value as { title: string; summary: string; latestEntry: { author: { kind: string; agentId: string } }; sessions: { current: boolean }[] };
  assert.equal(task.title, '接通能力层');
  assert.match(task.summary, /接好 MCP/);
  assert.equal(task.latestEntry.author.kind, 'agent');
  assert.equal(task.latestEntry.author.agentId, 'fake');
  assert.equal(task.sessions[0]?.current, true);
  const listed = await w.gateway.call(grant, 'task.log.list', { limit: 5 });
  assert.ok(listed.ok);
  assert.ok((listed.value as { entries: { author: { kind: string } }[] }).entries.some((e) => e.author.kind === 'agent'));
  // 审计：每次调用一条，正文只记长度
  assert.equal(w.toolGrants.calls.length, 3);
  assert.match(w.toolGrants.calls[0]?.detail ?? '', /body=<\d+ 字>/);
});

test('权限、校验与限流：body 必须是字符串；旧版的 kind 参数被忽略；agent 不能收尾；超频返回错误不断开', async () => {
  const w = await world();
  const { grant } = await w.gateway.issue(w.session, ['task:read']);
  const denied = await w.gateway.call(grant, 'task.log.append', { body: 'x' });
  assert.equal(denied.ok ? null : denied.error.code, 'forbidden');
  assert.equal(w.gateway.list(grant).length, 2);

  const full = (await w.gateway.issue(w.session)).grant;
  const system = await w.gateway.call(full, 'task.log.append', { body: 42 });
  assert.equal(system.ok ? null : system.error.code, 'invalid');
  const done = await w.gateway.call(full, 'task.update_status', { status: 'done' });
  assert.equal(done.ok, false);
  const review = await w.gateway.call(full, 'task.update_status', { status: 'in_review', note: '可以验收' });
  assert.ok(review.ok);
  assert.equal((await w.deps.tasks.byId(w.task.id))?.status, 'in_review');
  assert.equal((review.value as { changed: boolean }).changed, true);
  // 系统日志点名是哪个 agent 改的，并挂在它的会话上
  const logged = (await w.deps.workLog.list(w.task.id, { limit: 5 })).find((e) => /待验收/.test(e.body));
  assert.match(logged?.body ?? '', /^agent fake/);
  assert.equal(logged?.sessionId, w.session.id);
  // 重复设同一个状态：明确告诉模型「没变」，免得它反复重试
  const again = await w.gateway.call(full, 'task.update_status', { status: 'in_review' });
  assert.ok(again.ok);
  assert.equal((again.value as { changed: boolean }).changed, false);

  // 上面那次被拒的 append 也算一次 append：再来 9 次刚好用满 10 次/分钟
  assert.ok((await w.gateway.call(full, 'task.log.append', { kind: 'handoff', body: '旧客户端带 kind' })).ok);
  for (let i = 0; i < 8; i += 1) assert.ok((await w.gateway.call(full, 'task.log.append', { body: `n${i}` })).ok);
  const limited = await w.gateway.call(full, 'task.log.append', { body: 'too many' });
  assert.match(limited.ok ? '' : limited.error.message, /太频繁/);
  w.tick(61_000);
  assert.ok((await w.gateway.call(full, 'task.log.append', { body: 'ok again' })).ok);
});
