import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../access.ts';
import { asLoginId, asProjectId, asTeamId, asUserId, type Principal, type User } from '../index.ts';
import type { Project } from '../project.ts';
import { inMemoryApiTokens } from '../testing/in-memory.ts';
import { BOT_TOKEN_PREFIX } from '../api-token.ts';
import { authenticateApiToken, createApiToken, listApiTokens, revokeApiToken, type ApiTokenDeps } from './api-tokens.ts';

/** C1：bot 的独立凭据——签发要项目 admin；令牌只能在本项目里做事。 */
function userOf(id: string, role: User['role'] = 'member', teamId = 'team-1'): User {
  return {
    id: asUserId(id),
    email: `${id}@example.com`,
    displayName: id,
    role,
    passwordHash: null,
    emailVerifiedAt: 1,
    disabledAt: null,
    createdAt: 1,
    teamId: asTeamId(teamId),
    clusterAdmin: false,
    deletedAt: null
  };
}
const principalOf = (user: User): Principal => ({ user, loginId: asLoginId(`login-${user.id}`) });
const projectOf = (id: string, createdBy: string, teamId = 'team-1'): Project => ({
  id: asProjectId(id),
  name: id,
  repo: null,
  description: null,
  createdAt: 1,
  teamId,
  createdBy,
  members: [createdBy],
  worktree: null,
  deletedAt: null
});

function world() {
  const rows = new Map<string, Project>([
    ['p1', projectOf('p1', 'owner')],
    ['p2', projectOf('p2', 'owner')]
  ]);
  const apiTokens = inMemoryApiTokens();
  const users = new Map<string, User>();
  for (const user of [userOf('owner', 'owner'), userOf('admin', 'admin'), userOf('member')]) users.set(user.id, user);
  const auditRows: { detail: string }[] = [];
  let counter = 0;
  let clock = 1_700_000_000_000;
  const deps: ApiTokenDeps = {
    apiTokens,
    users: {
      byId: async (id) => users.get(id) ?? null,
      save: async (user) => void users.set(user.id, user)
    },
    projects: { byId: async (id) => rows.get(id) ?? null },
    botExists: async (projectId, name) => projectId === 'p1' && name !== 'nobody',
    tokens: {
      issue: () => ({ token: `secret-${++counter}`, hash: `issued-${counter}` }),
      hashOf: (raw) => `hash:${raw}`
    },
    audit: {
      append: async (entry) => void auditRows.push(entry as never),
      recent: async () => auditRows as never,
      query: async () => auditRows as never
    },
    now: () => (clock += 1)
  };
  const owner = principalOf(users.get('owner')!);
  const admin = principalOf(users.get('admin')!);
  const member = principalOf(users.get('member')!);
  const issueBot = async (actor = owner, projectId = 'p1') => {
    const made = await createApiToken(deps, actor, { name: 'reviewer', kind: 'bot', projectId, scopes: ['projects:read', 'sessions:write'] });
    assert.ok(made.ok, JSON.stringify(made));
    return made.value;
  };
  return { deps, apiTokens, users, auditRows, owner, admin, member, issueBot };
}

test('bot 令牌只在自己项目里有效，越界一律 bot_scope', async () => {
  const w = world();
  const made = await w.issueBot();
  assert.ok(made.token.startsWith(BOT_TOKEN_PREFIX), made.token);
  assert.deepEqual(made.info.bot, { projectId: 'p1', name: 'reviewer' });
  assert.equal(made.info.kind, 'bot');

  const bot = await authenticateApiToken(w.deps, made.token);
  assert.ok(bot?.via?.bot, 'authenticateApiToken 要带 via.bot');
  assert.deepEqual(bot.via.bot, { projectId: 'p1', name: 'reviewer' });
  // 有效权限与 BOT_PERMISSIONS 取交集：sessions:write 里的 fork / continue 不会生效；
  // worker.use 留着过「派发前最后一道」，但 HTTP 层对 bot 禁止 hub 本机（apps/server/src/access.ts）。
  assert.ok(bot.via.permissions.includes('session.prompt'));
  assert.ok(!bot.via.permissions.includes('session.fork'));
  assert.ok(bot.via.permissions.includes('worker.use'));

  const session = (projectId: string) => ({ kind: 'session' as const, id: 's1', projectId, teamId: 'team-1' });
  assert.equal(decide(bot, 'session.prompt', session('p1')).allow, true);
  const other = decide(bot, 'session.prompt', session('p2'));
  assert.equal(other.allow, false);
  assert.equal(other.allow === false && other.reason, 'bot_scope');

  assert.equal(decide(bot, 'project.read', { kind: 'project', id: 'p1', teamId: 'team-1' }).allow, true);
  const otherProject = decide(bot, 'project.read', { kind: 'project', id: 'p2', teamId: 'team-1' });
  assert.equal(otherProject.allow === false && otherProject.reason, 'bot_scope');
});

test('bot 令牌申请范围外的权限不会生效（project.create / project.update）', async () => {
  const w = world();
  // projects:write 会打包出 project.create / project.update；bot 的上限里没有它们。
  const made = await createApiToken(w.deps, w.owner, { name: 'writer', kind: 'bot', projectId: 'p1', scopes: ['projects:write'] });
  assert.ok(made.ok, JSON.stringify(made));
  const bot = await authenticateApiToken(w.deps, made.value.token);
  assert.ok(bot);

  const create = decide(bot, 'project.create', undefined);
  assert.equal(create.allow, false);
  // 交集已经把 project.create 从 via.permissions 里滤掉了，所以更早的令牌检查就拒了。
  assert.equal(create.allow === false && create.reason, 'token');
  const update = decide(bot, 'project.update', { kind: 'project', id: 'p1', teamId: 'team-1' });
  assert.equal(update.allow === false && update.reason, 'token');

  // 就算 via.permissions 被伪造得很宽，decide() 的 bot 上限仍然兜底。
  const forged: Principal = { ...bot, via: { ...bot.via!, permissions: ['project.update'] } };
  const capped = decide(forged, 'project.update', { kind: 'project', id: 'p1', teamId: 'team-1' });
  assert.equal(capped.allow === false && capped.reason, 'bot_scope');
});

test('bot 令牌：群发言 / 读文件 / 记忆走后加 scope，仍只在本项目里', async () => {
  const w = world();
  const made = await createApiToken(w.deps, w.owner, {
    name: 'reviewer',
    kind: 'bot',
    projectId: 'p1',
    scopes: ['projects:read', 'sessions:write', 'groups:write', 'files:read', 'memory:write']
  });
  assert.ok(made.ok, JSON.stringify(made));
  const bot = await authenticateApiToken(w.deps, made.value.token);
  assert.ok(bot);
  const project = (id: string) => ({ kind: 'project' as const, id, teamId: 'team-1' });
  for (const permission of ['group.post', 'workspace.files.read', 'memory.write'] as const) {
    assert.equal(decide(bot, permission, project('p1')).allow, true, permission);
    const cross = decide(bot, permission, project('p2'));
    assert.equal(cross.allow === false && cross.reason, 'bot_scope', permission);
  }
  // memory:read 不给写
  const readOnly = await createApiToken(w.deps, w.owner, { name: 'reader', kind: 'bot', projectId: 'p1', scopes: ['projects:read', 'memory:read'] });
  assert.ok(readOnly.ok);
  const reader = await authenticateApiToken(w.deps, readOnly.value.token);
  assert.ok(reader);
  assert.equal(decide(reader, 'memory.read', project('p1')).allow, true);
  assert.equal(decide(reader, 'memory.write', project('p1')).allow, false);
});

test('bot 令牌不能建令牌，也不能管机器', async () => {
  const w = world();
  const made = await w.issueBot();
  const bot = await authenticateApiToken(w.deps, made.token);
  assert.ok(bot);

  const again = await createApiToken(w.deps, bot, { name: 'nested', kind: 'personal', scopes: ['projects:read'] });
  assert.equal(again.ok, false);
  assert.equal(again.ok === false && again.error.code, 'forbidden');

  const worker = decide(bot, 'worker.manage', { kind: 'worker', id: 'w1', teamId: 'team-1' });
  assert.equal(worker.allow, false);
  assert.equal(worker.allow === false && worker.reason, 'token');
});

test('重新生成即轮换：同一个 bot 只留一条有效凭据；botName 必须在项目里', async () => {
  const w = world();
  const first = await w.issueBot();
  const bot = await authenticateApiToken(w.deps, first.token);
  assert.ok(bot);
  const second = await w.issueBot();
  assert.equal(await authenticateApiToken(w.deps, first.token), null, '旧凭据要失效');
  assert.ok(await authenticateApiToken(w.deps, second.token));

  const ghost = await createApiToken(w.deps, w.owner, { name: 'ghost', kind: 'bot', projectId: 'p1', botName: 'nobody', scopes: ['projects:read'] });
  assert.equal(ghost.ok, false);
  assert.equal(ghost.ok === false && ghost.error.code, 'invalid');
});

test('建 bot 令牌要项目 owner / admin；普通成员 403', async () => {
  const w = world();
  const denied = await createApiToken(w.deps, w.member, { name: 'reviewer', kind: 'bot', projectId: 'p1', scopes: ['sessions:read'] });
  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false && denied.error.code, 'forbidden');

  const byAdmin = await createApiToken(w.deps, w.admin, { name: 'reviewer', kind: 'bot', projectId: 'p1', scopes: ['sessions:read'] });
  assert.ok(byAdmin.ok, JSON.stringify(byAdmin));

  const noProject = await createApiToken(w.deps, w.owner, { name: 'reviewer', kind: 'bot', scopes: ['sessions:read'] });
  assert.equal(noProject.ok, false);
  assert.equal(noProject.ok === false && noProject.error.code, 'invalid');
});

test('bot 令牌对项目 admin 可见、可由项目 admin 吊销；吊销不停用签发人', async () => {
  const w = world();
  const made = await w.issueBot();
  assert.ok((await listApiTokens(w.deps, w.admin)).some((token) => token.id === made.info.id));
  assert.equal((await listApiTokens(w.deps, w.member)).some((token) => token.id === made.info.id), false);

  const denied = await revokeApiToken(w.deps, w.member, made.info.id);
  assert.equal(denied.ok, false);
  const revoked = await revokeApiToken(w.deps, w.owner, made.info.id);
  assert.ok(revoked.ok, JSON.stringify(revoked));
  assert.notEqual(revoked.value.revokedAt, null);
  assert.equal(w.users.get('owner')!.disabledAt, null);
  assert.ok(w.auditRows.some((row) => row.detail.includes('bot「reviewer」')), '审计里要能看出以 bot 身份');
  assert.equal(await authenticateApiToken(w.deps, made.token), null);
});
