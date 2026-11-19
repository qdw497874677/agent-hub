import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../access.ts';
import { asLoginId, asProjectId, asTeamId, asUserId, type Principal, type User } from '../index.ts';
import type { Project } from '../project.ts';
import { inMemoryApiTokens } from '../testing/in-memory.ts';
import { BOT_TOKEN_PREFIX } from '../api-token.ts';
import { apiTokenActivity, authenticateApiToken, createApiToken, listApiTokens, revokeApiToken, rotateApiToken, tokenManageGrantDenied, type ApiTokenDeps } from './api-tokens.ts';
import { MCP_TOKEN_MAX_TTL_MS } from '../api-token.ts';

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
  repos: [],
  description: null,
  createdAt: 1,
  teamId,
  createdBy,
  members: [createdBy],
  worktree: null,
  checks: [],
  assetSetIds: [],
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

test('默认有效期：个人令牌不给 = 30 天；显式 null = 永不过期；bot 凭据不给仍不过期', async () => {
  const { deps, owner, issueBot } = world();
  const plain = await createApiToken(deps, owner, { name: 'ci', kind: 'personal', scopes: ['projects:read'] });
  assert.ok(plain.ok);
  assert.ok(plain.value.info.expiresAt !== null);
  const days = (plain.value.info.expiresAt! - plain.value.info.createdAt) / 86_400_000;
  assert.ok(days > 29.99 && days <= 30, String(days));
  const forever = await createApiToken(deps, owner, { name: 'forever', kind: 'personal', scopes: ['projects:read'], expiresAt: null });
  assert.ok(forever.ok);
  assert.equal(forever.value.info.expiresAt, null);
  assert.equal((await issueBot()).info.expiresAt, null);
});

test('限定项目的令牌：只碰选中的项目，不能新建项目；看不到的项目不能选', async () => {
  const { deps, owner, member } = world();
  const made = await createApiToken(deps, owner, { name: 'scoped', kind: 'personal', scopes: ['projects:read', 'projects:write'], projectIds: ['p1'] });
  assert.ok(made.ok, JSON.stringify(made));
  assert.deepEqual(made.value.info.projectIds, ['p1']);
  const principal = await authenticateApiToken(deps, made.value.token);
  assert.ok(principal);
  assert.deepEqual(principal.via?.projectIds, ['p1']);
  const resource = (id: string) => ({ kind: 'project' as const, id, projectId: id, teamId: 'team-1', createdBy: 'owner', sharedWith: ['owner'] });
  assert.equal(decide(principal, 'project.read', resource('p1')).allow, true);
  assert.deepEqual(decide(principal, 'project.read', resource('p2')), { allow: false, reason: 'token_project' });
  assert.deepEqual(decide(principal, 'task.read', { kind: 'task', id: 't', projectId: 'p2', teamId: 'team-1', createdBy: 'owner' }), { allow: false, reason: 'token_project' });
  assert.deepEqual(decide(principal, 'project.create'), { allow: false, reason: 'token_project' });
  // 不限项目的老令牌照旧
  const wide = await createApiToken(deps, owner, { name: 'wide', kind: 'personal', scopes: ['projects:read'] });
  assert.ok(wide.ok);
  const widePrincipal = await authenticateApiToken(deps, wide.value.token);
  assert.equal(widePrincipal?.via?.projectIds, undefined);
  assert.equal(decide(widePrincipal, 'project.read', resource('p2')).allow, true);
  // 成员看不到 p1（owner 建的、没共享），不能限定到它
  const denied = await createApiToken(deps, member, { name: 'x', kind: 'personal', scopes: ['projects:read'], projectIds: ['p1'] });
  assert.equal(denied.ok, false);
  // bot 不收 projectIds
  assert.equal((await createApiToken(deps, owner, { name: 'b', kind: 'bot', projectId: 'p1', scopes: ['projects:read'], projectIds: ['p1'] })).ok, false);
});

test('轮换：新令牌同权限同范围、有效期长度不变；旧的吊销但记录还在；吊销过的不能再轮换', async () => {
  const { deps, owner, member, auditRows } = world();
  const made = await createApiToken(deps, owner, { name: 'ci', kind: 'personal', scopes: ['projects:read'], projectIds: ['p1'] });
  assert.ok(made.ok);
  const rotated = await rotateApiToken(deps, owner, made.value.info.id);
  assert.ok(rotated.ok, JSON.stringify(rotated));
  assert.notEqual(rotated.value.token, made.value.token);
  assert.deepEqual(rotated.value.info.projectIds, ['p1']);
  assert.deepEqual(rotated.value.info.scopes, ['projects:read']);
  const length = (t: { createdAt: number; expiresAt: number | null }) => (t.expiresAt ?? 0) - t.createdAt;
  assert.equal(length(rotated.value.info), length(made.value.info));
  assert.equal(await authenticateApiToken(deps, made.value.token), null);
  assert.ok(await authenticateApiToken(deps, rotated.value.token));
  const listed = await listApiTokens(deps, owner);
  assert.ok(listed.some((t) => t.id === made.value.info.id && t.revokedAt !== null), '旧记录保留');
  assert.ok(auditRows.some((row) => row.detail.includes('ci')));
  assert.equal((await rotateApiToken(deps, owner, made.value.info.id)).ok, false);
  // 别人的令牌：当作不存在
  assert.equal((await rotateApiToken(deps, member, rotated.value.info.id)).ok, false);
});

test('令牌活动：只给管得了它的人看', async () => {
  const { deps, owner, member } = world();
  const made = await createApiToken(deps, owner, { name: 'ci', kind: 'personal', scopes: ['projects:read'] });
  assert.ok(made.ok);
  assert.ok((await apiTokenActivity(deps, owner, made.value.info.id)).ok);
  assert.equal((await apiTokenActivity(deps, member, made.value.info.id)).ok, false);
});

test('bot 凭据永不过期：不吃 30 天默认、不能设有效期、重新生成仍不过期、老库里带到期时间的照样能用', async () => {
  const { deps, apiTokens, owner } = world();
  // 新建：不给有效期 → null；显式给有效期 → 拒绝
  const made = await createApiToken(deps, owner, { name: 'reviewer', kind: 'bot', projectId: 'p1', scopes: ['projects:read'] });
  assert.ok(made.ok, JSON.stringify(made));
  assert.equal(made.value.info.expiresAt, null);
  const dated = await createApiToken(deps, owner, { name: 'reviewer', kind: 'bot', projectId: 'p1', scopes: ['projects:read'], expiresAt: deps.now() + 86_400_000 });
  assert.ok(!dated.ok);
  assert.equal(dated.error.code, 'invalid');
  // 重新生成（同名 bot 再建一次 = 轮换）：新的一份也不过期
  const again = await createApiToken(deps, owner, { name: 'reviewer', kind: 'bot', projectId: 'p1', scopes: ['projects:read'] });
  assert.ok(again.ok);
  assert.equal(again.value.info.expiresAt, null);
  assert.ok(await authenticateApiToken(deps, again.value.token));
  // 老库里的 bot 凭据存了一个早就过去的到期时间：照样能用，列表里也不显示到期
  const legacy = { ...(await apiTokens.byId(again.value.info.id))!, id: 'legacy-bot', tokenHash: 'hash:ahb_legacy', bot: { projectId: 'p1', name: 'old' }, name: 'old', expiresAt: 1, revokedAt: null };
  await apiTokens.save(legacy);
  assert.ok(await authenticateApiToken(deps, 'ahb_legacy'), '老 bot 凭据不能因为到期时间失效');
  const row = (await listApiTokens(deps, owner)).find((t) => t.id === 'legacy-bot');
  assert.equal(row?.expiresAt, null);
  assert.equal(row?.usable, true);
  // 个人令牌照旧：过期就不能用
  await apiTokens.save({ ...legacy, id: 'old-personal', kind: 'personal', bot: undefined, tokenHash: 'hash:ahp_old', expiresAt: 1 });
  assert.equal(await authenticateApiToken(deps, 'ahp_old'), null);
});

test('bot 凭据不走令牌轮换（只能在 Bot 页重新生成，仍不过期）；轮换不会给它加有效期', async () => {
  const { deps, owner, issueBot } = world();
  const bot = await issueBot();
  const rotated = await rotateApiToken(deps, owner, bot.info.id);
  assert.ok(!rotated.ok);
  assert.ok(await authenticateApiToken(deps, bot.token), '拒绝轮换不影响原凭据');
  assert.equal((await listApiTokens(deps, owner)).find((t) => t.id === bot.info.id)?.expiresAt, null);
});

test('限定项目的令牌：认证时带上项目所在团队；同团队的团队资产放行，别的团队 / 没团队的项目不放行', async () => {
  const { deps, owner } = world();
  const made = await createApiToken(deps, owner, { name: 'scoped', kind: 'personal', scopes: ['assets:read', 'assets:write'], projectIds: ['p1'] });
  assert.ok(made.ok, JSON.stringify(made));
  const principal = await authenticateApiToken(deps, made.value.token);
  assert.deepEqual(principal?.via?.teamIds, ['team-1']);
  const teamAsset = (teamId: string | null) => ({ kind: 'asset' as const, teamId, createdBy: 'owner' });
  assert.equal(decide(principal, 'asset.submit', teamAsset('team-1')).allow, true);
  assert.equal(decide(principal, 'asset.submit', teamAsset('team-2')).allow, false);
  assert.equal(decide(principal, 'asset.read', teamAsset(null)).allow, false);
  // 项目资产仍按项目判
  assert.equal(decide(principal, 'asset.submit', { ...teamAsset('team-1'), projectId: 'p1' }).allow, true);
  assert.deepEqual(decide(principal, 'asset.submit', { ...teamAsset('team-1'), projectId: 'p2' }), { allow: false, reason: 'token_project' });
  // 项目不在团队里：没有 teamIds，团队资产不放行
  const loose = { ...principal!, via: { ...principal!.via!, teamIds: undefined } };
  assert.deepEqual(decide(loose, 'asset.submit', teamAsset('team-1')), { allow: false, reason: 'token_project' });
});

test('providers:manage：管理员能授；成员不能；项目级和 bot 一律拒绝；调用时限定项目也拒', async () => {
  const { deps, owner, admin, member } = world();
  const okOwner = await createApiToken(deps, owner, { name: 'mgr', kind: 'personal', scopes: ['providers:manage'] });
  assert.ok(okOwner.ok, JSON.stringify(okOwner));
  const okAdmin = await createApiToken(deps, admin, { name: 'mgr-admin', kind: 'personal', scopes: ['providers:read', 'providers:manage'] });
  assert.ok(okAdmin.ok, JSON.stringify(okAdmin));

  const asMember = await createApiToken(deps, member, { name: 'nope', kind: 'personal', scopes: ['providers:manage'] });
  assert.equal(asMember.ok, false);
  if (!asMember.ok) assert.match(asMember.error.message, /只有管理员/);

  const scoped = await createApiToken(deps, owner, { name: 'scoped-mgr', kind: 'personal', scopes: ['providers:manage'], projectIds: ['p1'] });
  assert.equal(scoped.ok, false);
  if (!scoped.ok) assert.match(scoped.error.message, /只限项目/);

  const bot = await createApiToken(deps, owner, { name: 'bot-mgr', kind: 'bot', projectId: 'p1', scopes: ['providers:manage'] });
  assert.equal(bot.ok, false);
  if (!bot.ok) assert.match(bot.error.message, /bot 凭据/);

  const principal = await authenticateApiToken(deps, okOwner.value.token);
  assert.ok(principal);
  assert.ok(principal.via?.permissions.includes('provider.manage'));
  assert.equal(decide(principal, 'provider.manage').allow, true);

  // 调用时再挡一层：即便 scopes 里有，限定项目的令牌也管不了。
  const forged = { ...principal, via: { ...principal.via!, projectIds: ['p1'] } };
  const denied = decide(forged, 'provider.manage');
  assert.equal(denied.allow, false);
  assert.equal(denied.allow === false && denied.reason, 'token_project');
});


test('tokens:manage：管理员能授；成员不能；项目级和 bot 一律拒绝', async () => {
  const { deps, owner, admin, member } = world();
  const okOwner = await createApiToken(deps, owner, { name: 'tokmgr', kind: 'personal', scopes: ['tokens:manage', 'projects:read'] });
  assert.ok(okOwner.ok);
  const okAdmin = await createApiToken(deps, admin, { name: 'tokmgr-admin', kind: 'personal', scopes: ['tokens:manage'] });
  assert.ok(okAdmin.ok);
  const asMember = await createApiToken(deps, member, { name: 'nope', kind: 'personal', scopes: ['tokens:manage'] });
  assert.equal(asMember.ok, false);
  const scoped = await createApiToken(deps, owner, { name: 'scoped', kind: 'personal', scopes: ['tokens:manage'], projectIds: ['p1'] });
  assert.equal(scoped.ok, false);
  const bot = await createApiToken(deps, owner, { name: 'bot-tok', kind: 'bot', projectId: 'p1', scopes: ['tokens:manage'] });
  assert.equal(bot.ok, false);
  assert.equal(tokenManageGrantDenied(owner, { kind: 'personal', scopes: ['projects:read'] }), null);
});

test('经 tokens:manage 令牌可签发子集个人令牌：要过期、不能提权、明文只在结果里、审计不记明文', async () => {
  const { deps, owner } = world();
  const adminTok = await createApiToken(deps, owner, {
    name: 'admin-mcp',
    kind: 'personal',
    scopes: ['tokens:manage', 'projects:read', 'sessions:read']
  });
  assert.ok(adminTok.ok);
  const actor = await authenticateApiToken(deps, adminTok.value.token);
  assert.ok(actor && actor.via);
  const now = deps.now();
  const made = await createApiToken(deps, actor, {
    name: 'e2e',
    kind: 'personal',
    scopes: ['projects:read'],
    expiresAt: now + 60_000
  });
  assert.ok(made.ok, JSON.stringify(made));
  assert.match(made.value.token, /^ahp_/);
  assert.ok(!made.value.info.scopes.includes('tokens:manage'));
  const audit = (await deps.audit!.query({ limit: 200 })) as { detail: string; action: string }[];
  // query mock returns all auditRows pushed as entry
  const rows = audit as unknown as { detail?: string; action?: string }[];
  assert.ok(rows.some((row) => (row.action === 'token.create' || JSON.stringify(row).includes('token.create'))));
  assert.ok(!JSON.stringify(rows).includes(made.value.token));

  const escalate = await createApiToken(deps, actor, {
    name: 'esc',
    kind: 'personal',
    scopes: ['tokens:manage'],
    expiresAt: now + 60_000
  });
  assert.equal(escalate.ok, false);
  const prov = await createApiToken(deps, actor, {
    name: 'prov',
    kind: 'personal',
    scopes: ['providers:manage'],
    expiresAt: now + 60_000
  });
  assert.equal(prov.ok, false);
  const wider = await createApiToken(deps, actor, {
    name: 'wide',
    kind: 'personal',
    scopes: ['projects:write'],
    expiresAt: now + 60_000
  });
  assert.equal(wider.ok, false);
  const noExp = await createApiToken(deps, actor, {
    name: 'immortal',
    kind: 'personal',
    scopes: ['projects:read']
  });
  assert.equal(noExp.ok, false);
  const tooLong = await createApiToken(deps, actor, {
    name: 'long',
    kind: 'personal',
    scopes: ['projects:read'],
    expiresAt: now + MCP_TOKEN_MAX_TTL_MS + 86_400_000
  });
  assert.equal(tooLong.ok, false);
  const asService = await createApiToken(deps, actor, {
    name: 'svc',
    kind: 'service',
    scopes: ['projects:read'],
    expiresAt: now + 60_000
  });
  assert.equal(asService.ok, false);

  const listed = await listApiTokens(deps, actor);
  assert.ok(listed.some((row) => row.name === 'e2e'));
  const revoked = await revokeApiToken(deps, actor, made.value.info.id);
  assert.ok(revoked.ok);
  assert.ok(revoked.value.revokedAt !== null);
});

test('没有 tokens:manage 的令牌仍然不能创建 / 吊销 / 轮换令牌', async () => {
  const { deps, owner } = world();
  const plain = await createApiToken(deps, owner, { name: 'plain', kind: 'personal', scopes: ['projects:read'] });
  assert.ok(plain.ok);
  const actor = await authenticateApiToken(deps, plain.value.token);
  assert.ok(actor && actor.via);
  const denied = await createApiToken(deps, actor, { name: 'x', kind: 'personal', scopes: ['projects:read'], expiresAt: deps.now() + 60_000 });
  assert.equal(denied.ok, false);
  const rotate = await rotateApiToken(deps, actor, plain.value.info.id);
  assert.equal(rotate.ok, false);
  const revoke = await revokeApiToken(deps, actor, plain.value.info.id);
  assert.equal(revoke.ok, false);
});

test('经 tokens:manage 令牌轮换：旧令牌的 scope 超出自身权限或带提权 scope 一律拒绝（#261 HIGH1）', async () => {
  const { deps, owner } = world();
  const callerTok = await createApiToken(deps, owner, { name: 'caller', kind: 'personal', scopes: ['tokens:manage', 'projects:read'] });
  assert.ok(callerTok.ok);
  const actor = await authenticateApiToken(deps, callerTok.value.token);
  assert.ok(actor && actor.via);

  // 目标：同一用户的 providers:manage 个人令牌——轮换等于重签，不能绕开提权检查。
  const esc = await createApiToken(deps, owner, { name: 'prov-tok', kind: 'personal', scopes: ['providers:manage'] });
  assert.ok(esc.ok);
  const escOld = await deps.apiTokens.byId(esc.value.info.id);
  assert.ok(escOld && escOld.revokedAt === null);
  const escRotated = await rotateApiToken(deps, actor, esc.value.info.id);
  assert.equal(escRotated.ok, false);
  if (!escRotated.ok) assert.match(escRotated.error.message, /提权|tokens:manage 或 providers:manage/);
  // 旧令牌没有被吊销，还能正常鉴权；库里也没有出现新哈希。
  const escStillValid = await authenticateApiToken(deps, esc.value.token);
  assert.ok(escStillValid && escStillValid.via && (escStillValid.via.scopes ?? []).includes('providers:manage'));
  const escAfter = await deps.apiTokens.byId(esc.value.info.id);
  assert.ok(escAfter && escAfter.tokenHash === `hash:${esc.value.token}` && escAfter.revokedAt === null);
  const escRows = await deps.apiTokens.listByTeam('team-1');
  assert.equal(escRows.filter((row) => row.name === 'prov-tok').length, 1);

  // 目标：同一用户的 projects:write 个人令牌——projects:write 不在调用方自身权限内。
  const wider = await createApiToken(deps, owner, { name: 'wide-tok', kind: 'personal', scopes: ['projects:write'] });
  assert.ok(wider.ok);
  const widerRotated = await rotateApiToken(deps, actor, wider.value.info.id);
  assert.equal(widerRotated.ok, false);
  if (!widerRotated.ok) assert.match(widerRotated.error.message, /自身权限/);
  const widerStillValid = await authenticateApiToken(deps, wider.value.token);
  assert.ok(widerStillValid);
  const widerRows = await deps.apiTokens.listByTeam('team-1');
  assert.equal(widerRows.filter((row) => row.name === 'wide-tok').length, 1);

  // 对照：旧令牌的 scope 是自身权限的子集时，轮换照常成功。
  const subset = await createApiToken(deps, owner, { name: 'subset-tok', kind: 'personal', scopes: ['projects:read'], expiresAt: deps.now() + 3_600_000 });
  assert.ok(subset.ok);
  const subsetRotated = await rotateApiToken(deps, actor, subset.value.info.id);
  assert.ok(subsetRotated.ok, JSON.stringify(subsetRotated));
  assert.deepEqual(subsetRotated.ok ? subsetRotated.value.info.scopes : [], ['projects:read']);
  const subsetOld = await deps.apiTokens.byId(subset.value.info.id);
  assert.ok(subsetOld && subsetOld.revokedAt !== null);
});
