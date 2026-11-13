import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAccounts, inMemoryDeps } from '@agent-hub/domain/testing';
import {
  createAccessPolicy,
  createBotUseCase,
  getBotUseCase,
  listBotsUseCase,
  ok,
  removeBotUseCase,
  updateBotUseCase,
  type AgentTaskStore,
  type BindingView,
  type ConnectorHub,
  type TriggerRun
} from '@agent-hub/domain';
import { createApp, type AppOptions } from './http.ts';
import { createStreamHub } from './stream-hub.ts';

const PASSWORD = 'long enough pw';

function harness(extra: Partial<AppOptions> = {}) {
  const accounts = inMemoryAccounts();
  const world = inMemoryDeps();
  const access = createAccessPolicy({
    users: accounts.users,
    settings: accounts.settings,
    enrollment: { credentialFor: async () => null },
    gateway: world.deps.gateway
  });
  const deps = { ...world.deps, access };
  // 回落读的是旧的 roles 列：测试里没有迁移前的数据。
  const botDeps = { ...deps, messages: { config: async () => null } };
  const app = createApp({
    deps,
    hub: createStreamHub(),
    token: null,
    auth: { accounts },
    bots: {
      listBots: (actor, projectId) => listBotsUseCase(botDeps, actor, projectId),
      getBot: (actor, id) => getBotUseCase(botDeps, actor, id),
      createBot: (actor, projectId, input) => createBotUseCase(botDeps, actor, projectId, input),
      updateBot: (actor, id, patch) => updateBotUseCase(botDeps, actor, id, patch),
      removeBot: (actor, id) => removeBotUseCase(botDeps, actor, id)
    },
    ...extra
  });
  const browser = () => {
    const jar = new Map<string, string>();
    return async (path: string, init: RequestInit = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (jar.get('hub_csrf')) headers['x-hub-csrf'] = jar.get('hub_csrf')!;
      const response = await app.fetch(new Request(`http://hub${path}`, { ...init, headers }));
      for (const line of response.headers.getSetCookie()) {
        const [name, value] = line.split(';')[0]!.split('=');
        if (value === '' || /Max-Age=0/.test(line)) jar.delete(name!);
        else jar.set(name!, value!);
      }
      return { status: response.status, body: (await response.json().catch(() => null)) as any };
    };
  };
  return { accounts, browser };
}

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });
const patch = (body: unknown) => ({ method: 'PATCH', body: JSON.stringify(body) });

async function setup(extra: Partial<AppOptions> = {}) {
  const { accounts, browser } = harness(extra);
  const david = browser();
  assert.equal((await david('/api/auth/register', post({ email: 'david@b.co', password: PASSWORD }))).status, 200);
  assert.equal((await david('/api/auth/login', post({ email: 'david@b.co', password: PASSWORD }))).status, 200);
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  assert.ok(project.id);
  return { accounts, david, project };
}

test('bot 路由：列表、创建、改名被拒、删除', async () => {
  const { david, project } = await setup();

  assert.equal((await david('/api/bots')).status, 400);
  assert.deepEqual((await david(`/api/bots?projectId=${project.id}`)).body, { bots: [] });

  const created = await david('/api/bots', post({ projectId: project.id, name: 'qa', agentId: 'pi', description: '测试', reuse: 'sticky' }));
  assert.equal(created.status, 201);
  assert.match(created.body.id, /^bot_[0-9a-f]{16}$/);
  assert.equal(created.body.projectId, project.id);
  assert.equal(created.body.name, 'qa');
  assert.equal(created.body.agentId, 'pi');
  assert.equal(created.body.model, '');
  assert.equal(created.body.description, '测试');

  const listed = await david(`/api/bots?projectId=${project.id}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.bots.map((bot: any) => bot.name), ['qa']);

  const got = await david(`/api/bots/${created.body.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.name, 'qa');

  const duplicate = await david('/api/bots', post({ projectId: project.id, name: 'qa', agentId: 'pi' }));
  assert.equal(duplicate.status, 400);

  const renamed = await david(`/api/bots/${created.body.id}`, patch({ name: 'qc' }));
  assert.equal(renamed.status, 400);
  assert.match(renamed.body.error.message, /建好就不能改/);

  const edited = await david(`/api/bots/${created.body.id}`, patch({ displayName: '质检', agentId: 'pi', model: 'm1' }));
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.displayName, '质检');
  assert.equal(edited.body.model, 'm1');

  const removed = await david(`/api/bots/${created.body.id}`, { method: 'DELETE' });
  assert.deepEqual(removed, { status: 200, body: { ok: true } });
  assert.equal((await david(`/api/bots/${created.body.id}`)).status, 404);
});

// ---- C4：触发器读接口 ----

const binding = (over: Partial<BindingView> = {}): BindingView => ({
  id: 'bnd_1', connector: 'timer', kind: 'tick', agentProjectId: 'proj_1', agentName: 'qa',
  projectId: null, name: '每天早上', target: 'main', params: {}, enabled: true, pausedReason: null,
  consecutiveFailures: 0, nextRunAt: null, mainSessionId: null, createdBy: 'user_1', timeZone: 'UTC',
  createdAt: 100, updatedAt: 200, summary: '每 15 分钟', lastRun: null, ...over
});

const run = (index: number): TriggerRun => ({
  id: `run_${index}`, bindingId: 'bnd_1', externalId: `ext_${index}`, plannedAt: 1_000 + index, catchup: index === 0,
  state: 'done', reason: null, sessionId: 'ses_1', text: `第 ${index} 次的唤醒内容`, createdAt: 2_000 + index, updatedAt: 3_000 + index
});

/** 只实现 bot 触发器读接口用到的三个方法；agentTasks 是装 connector 路由的形状要求。 */
const fakeHub = (bindings: readonly BindingView[], runs: readonly TriggerRun[]) => ({
  sources: () => [{ id: 'timer', kinds: ['tick'] }, { id: 'github', kinds: ['issue'] }],
  list: async () => ok([...bindings]),
  runs: async (_actor: unknown, _id: string, limit = 30) => ok(runs.slice(0, limit))
});
/** AppOptions 里 `connectors.hub` 是完整 ConnectorHub；这里只喂读接口用到的三件。 */
const asHub = (bindings: readonly BindingView[], runs: readonly TriggerRun[]) => fakeHub(bindings, runs) as unknown as ConnectorHub;
const fakeTasks = { pendingFor: async () => [] } as unknown as AgentTaskStore;

test('bot 触发器：按 id 读，带最近运行与来源', async () => {
  const runs = Array.from({ length: 7 }, (_, index) => run(index));
  const { david, project } = await setup({ connectors: { hub: asHub([binding()], runs), agentTasks: fakeTasks } });
  const created = await david('/api/bots', post({ projectId: project.id, name: 'qa', agentId: 'pi' }));

  const got = await david(`/api/bots/${created.body.id}/triggers`);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  // 来源的形状跟 hub.sources() 一致：id + kinds，没有显示名。
  assert.deepEqual(got.body.sources, [{ id: 'timer', kinds: ['tick'] }, { id: 'github', kinds: ['issue'] }]);
  assert.equal(got.body.bindings.length, 1);
  const trigger = got.body.bindings[0];
  assert.equal(trigger.id, 'bnd_1');
  assert.equal(trigger.name, '每天早上');
  assert.equal(trigger.connector, 'timer');
  assert.equal(trigger.target, 'main');
  assert.equal(trigger.projectId, null);
  assert.equal(trigger.enabled, true);
  // 只回最近 5 条，且按 hub.runs 给的顺序。
  assert.deepEqual(trigger.runs.map((r: any) => r.id), ['run_0', 'run_1', 'run_2', 'run_3', 'run_4']);
  assert.equal(trigger.runs[0].state, 'done');
  assert.equal(trigger.runs[0].catchup, true);
  assert.equal(trigger.runs[0].sessionId, 'ses_1');
  // 运行记录里的 text（投进去的原文）不外泄。
  assert.equal('text' in trigger.runs[0], false);
});

test('bot 触发器：按名字读要带 projectId；单条也支持按名字', async () => {
  const { david, project } = await setup({ connectors: { hub: asHub([binding()], [run(0)]), agentTasks: fakeTasks } });
  await david('/api/bots', post({ projectId: project.id, name: 'qa', agentId: 'pi' }));

  const byName = await david(`/api/bots/qa/triggers?projectId=${project.id}`);
  assert.equal(byName.status, 200, JSON.stringify(byName.body));
  assert.deepEqual(byName.body.bindings.map((b: any) => b.id), ['bnd_1']);

  const noProject = await david('/api/bots/qa/triggers');
  assert.equal(noProject.status, 400);
  assert.match(noProject.body.error.message, /按名字找 bot 要带 projectId/);

  const single = await david(`/api/bots/qa?projectId=${project.id}`);
  assert.equal(single.status, 200);
  assert.equal(single.body.name, 'qa');

  assert.equal((await david('/api/bots/qa')).status, 400);
  assert.equal((await david(`/api/bots/nobody?projectId=${project.id}`)).status, 404);
  assert.equal((await david(`/api/bots/nobody/triggers?projectId=${project.id}`)).status, 404);
});

test('bot 触发器：没接连接器时回空列表', async () => {
  const { david, project } = await setup();
  const created = await david('/api/bots', post({ projectId: project.id, name: 'qa', agentId: 'pi' }));

  const got = await david(`/api/bots/${created.body.id}/triggers`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, { sources: [], bindings: [] });
});
