import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botIdFrom, type Bot, type ConnectorBinding, type MessagingConfig } from '../index.ts';
import { createProject } from '../project.ts';
import type { Principal, User } from '../account.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import {
  createBotUseCase,
  getBotUseCase,
  listBotsUseCase,
  loadBotConfig,
  removeBotUseCase,
  updateBotUseCase
} from './bots.ts';

const user: User = {
  id: 'u1',
  email: 'alice@x.test',
  displayName: 'Alice',
  role: 'member',
  passwordHash: null,
  emailVerifiedAt: 1,
  disabledAt: null,
  createdAt: 1,
  teamId: 'T',
  clusterAdmin: false,
  deletedAt: null
} as unknown as User;
const alice = { user, loginId: 'l' } as unknown as Principal;

/** 只提供 config() 的旧配置端口；legacy 是「迁移前仍躺在 agent_messaging_config.roles 里的数据」。 */
function world(legacy: MessagingConfig | null = null) {
  const memory = inMemoryDeps();
  const messages = { config: async () => legacy };
  const deps = { ...memory.deps, messages };
  return { deps, memory };
}

async function withProject() {
  const w = world();
  const project = createProject({ name: 'p', now: 1, teamId: 'T', createdBy: 'u1' });
  assert.ok(project.ok);
  await w.deps.projects.save(project.value);
  return { ...w, project: project.value };
}

test('bot 用例：创建、查重、按项目列、按 id 取', async () => {
  const { deps, project } = await withProject();
  const created = await createBotUseCase(deps, alice, project.id, { name: 'qa', agentId: 'pi', description: '测试' });
  assert.ok(created.ok, created.ok ? '' : created.error.message);
  assert.match(created.value.id, /^bot_[0-9a-f]{16}$/);
  assert.equal(created.value.projectId, project.id);
  assert.equal(created.value.reuse, 'sticky');

  const duplicate = await createBotUseCase(deps, alice, project.id, { name: 'qa', agentId: 'pi' });
  assert.ok(!duplicate.ok && /已经有了/.test(duplicate.error.message));

  const badName = await createBotUseCase(deps, alice, project.id, { name: 'QA 测试', agentId: 'pi' });
  assert.ok(!badName.ok);

  const listed = await listBotsUseCase(deps, alice, project.id);
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.map((bot) => bot.name), ['qa']);

  const got = await getBotUseCase(deps, alice, created.value.id);
  assert.ok(got.ok);
  assert.equal(got.value.name, 'qa');
});

test('bot 用例：能改字段，不能改 name', async () => {
  const { deps, project } = await withProject();
  const created = await createBotUseCase(deps, alice, project.id, { name: 'qa', agentId: 'pi' });
  assert.ok(created.ok);

  const renamed = await updateBotUseCase(deps, alice, created.value.id, { name: 'qc' });
  assert.ok(!renamed.ok);
  assert.ok(!renamed.ok && renamed.error.code === 'invalid' && /建好就不能改/.test(renamed.error.message));

  const edited = await updateBotUseCase(deps, alice, created.value.id, { displayName: '质检', description: '新职责', color: 'rose' });
  assert.ok(edited.ok, edited.ok ? '' : edited.error.message);
  assert.equal(edited.value.name, 'qa');
  assert.equal(edited.value.displayName, '质检');
  assert.equal(edited.value.description, '新职责');
  assert.equal(edited.value.color, 'rose');

  // 同名传回来不算改名
  const same = await updateBotUseCase(deps, alice, created.value.id, { name: 'qa', displayName: '质检 v2' });
  assert.ok(same.ok, same.ok ? '' : same.error.message);
  assert.equal(same.value.displayName, '质检 v2');
});

test('bot 用例：删除只删 bot 行', async () => {
  const { deps, project } = await withProject();
  const created = await createBotUseCase(deps, alice, project.id, { name: 'qa', agentId: 'pi' });
  assert.ok(created.ok);
  const removed = await removeBotUseCase(deps, alice, created.value.id);
  assert.deepEqual(removed, { ok: true, value: { removed: true } });
  assert.equal(await deps.bots.byId(created.value.id), null);
  assert.ok(!(await getBotUseCase(deps, alice, created.value.id)).ok);
});

test('bot 用例：删除顺手清掉连接器 binding 与上下文设置（#221）', async () => {
  const { deps, project } = await withProject();
  const created = await createBotUseCase(deps, alice, project.id, { name: 'qa', agentId: 'pi' });
  assert.ok(created.ok);
  const asked: { projectId: string; name: string }[] = [];
  const deleted: string[] = [];
  const cleared: { key: string; value: unknown }[] = [];
  const wired = {
    ...deps,
    connectors: {
      bindingsOf: async (projectId: string, name: string) => {
        asked.push({ projectId, name });
        return name === 'qa' ? ([{ id: 'b1' }, { id: 'b2' }] as unknown as ConnectorBinding[]) : [];
      },
      deleteBinding: async (id: string) => void deleted.push(id)
    },
    contextSettings: { set: async (key: string, value: unknown) => void cleared.push({ key, value }) }
  };
  const removed = await removeBotUseCase(wired, alice, created.value.id);
  assert.ok(removed.ok, removed.ok ? '' : removed.error.message);
  assert.deepEqual(asked, [{ projectId: project.id, name: 'qa' }]);
  assert.deepEqual(deleted, ['b1', 'b2']);
  // 新旧两套键都清（旧库还有 role:<pid>:<name>）
  assert.deepEqual(cleared, [
    { key: `bot:${project.id}:qa`, value: null },
    { key: `role:${project.id}:qa`, value: null }
  ]);
  // 别的 bot 的 binding 不动
  const coder = await createBotUseCase(deps, alice, project.id, { name: 'coder', agentId: 'pi' });
  assert.ok(coder.ok);
  await removeBotUseCase(wired, alice, coder.value.id);
  assert.deepEqual(deleted, ['b1', 'b2']);
});

test('bot 用例：改名被拒；同名重建沿用确定 id，不同名字不会拿到同一个 id（#221）', async () => {
  const { deps, project } = await withProject();
  const first = await createBotUseCase(deps, alice, project.id, { name: 'qa', agentId: 'pi' });
  assert.ok(first.ok);
  const rename = await updateBotUseCase(deps, alice, first.value.id, { name: 'qc' });
  assert.ok(!rename.ok && /建好就不能改/.test(rename.error.message));

  const other = await createBotUseCase(deps, alice, project.id, { name: 'coder', agentId: 'pi' });
  assert.ok(other.ok);
  assert.notEqual(other.value.id, first.value.id);

  // 删掉再建同名：id 只由 (projectId, name) 决定，仍会得到同一个 id（bot.ts 有意为之），
  // 所以不会把旧会话串到「另一个 bot」上；想彻底隔离只能换 id 生成策略。
  assert.ok((await removeBotUseCase(deps, alice, first.value.id)).ok);
  const again = await createBotUseCase(deps, alice, project.id, { name: 'qa', agentId: 'pi' });
  assert.ok(again.ok);
  assert.equal(again.value.id, first.value.id);
  assert.notEqual(again.value.id, other.value.id);
});

test('消息配置从 bots 表读，不再读旧 roles JSON', async () => {
  const w = await withProject();
  const created = await createBotUseCase(w.deps, alice, w.project.id, { name: 'qa', agentId: 'pi' });
  assert.ok(created.ok);
  const config = await loadBotConfig(w.deps, w.project.id);
  assert.deepEqual(config.roles.map((bot) => bot.name), ['qa']);
  assert.equal(config.roles[0]?.id, created.value.id);
});

test('bots 表为空时回落到旧 roles JSON（只读、不写回）', async () => {
  const legacyRole = {
    name: 'reviewer',
    description: '审代码',
    ref: { runtime: 'pi', model: 'm', options: {} },
    reuse: 'sticky' as const
  };
  const w = await withProject();
  const legacy: MessagingConfig = {
    projectId: w.project.id,
    roles: [legacyRole] as never,
    limits: { maxDepth: 6 },
    updatedAt: 42
  };
  const deps = { ...w.deps, messages: { config: async () => legacy } };

  const listed = await listBotsUseCase(deps, alice, w.project.id);
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.map((bot) => bot.name), ['reviewer']);
  const fallback: Bot = listed.value[0]!;
  assert.equal(fallback.id, botIdFrom(`${w.project.id}\0reviewer`));
  assert.equal(fallback.projectId, w.project.id);
  assert.equal(fallback.createdAt, 42);

  const config = await loadBotConfig(deps, w.project.id);
  assert.deepEqual(config.roles.map((bot) => bot.name), ['reviewer']);
  assert.deepEqual(config.limits, { maxDepth: 6 });
  assert.equal(config.updatedAt, 42);

  // 回落是只读的：表里仍然没有
  assert.deepEqual(await deps.bots.list(w.project.id), []);
});
