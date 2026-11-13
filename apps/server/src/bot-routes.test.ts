import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAccounts, inMemoryDeps } from '@agent-hub/domain/testing';
import {
  createAccessPolicy,
  createBotUseCase,
  getBotUseCase,
  listBotsUseCase,
  removeBotUseCase,
  updateBotUseCase
} from '@agent-hub/domain';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';

const PASSWORD = 'long enough pw';

function harness() {
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
    }
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

async function setup() {
  const { accounts, browser } = harness();
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
