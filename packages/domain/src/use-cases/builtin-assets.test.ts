import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LoginId, Principal, TeamId, User, UserId } from '../account.ts';
import { resolveProjectAssets } from '../asset.ts';
import { BUILTIN_ASSETS, builtinById } from '../builtin-assets.ts';
import { parseMcpAsset, secretKey } from '../index.ts';
import { inMemoryAdmin, inMemoryAssetReviewDeps, inMemoryAssets } from '../testing/in-memory.ts';
import { submitNewAsset } from './asset-review.ts';
import { builtinAssetsFor, enableBuiltinAsset, updateBuiltinAsset } from './builtin-assets.ts';

const enc = (text: string) => new TextEncoder().encode(text);

async function world() {
  const admin = inMemoryAdmin();
  const assets = inMemoryAssets();
  const { deps } = inMemoryAssetReviewDeps(admin, assets, new Map());
  const people: Record<string, Principal> = {};
  const mk = async (key: string, team: string, role: 'owner' | 'member') => {
    const user: User = {
      id: `u-${key}` as UserId,
      email: `${key.toLowerCase()}@x.co`,
      displayName: key,
      role,
      passwordHash: null,
      emailVerifiedAt: 1,
      disabledAt: null,
      createdAt: 1,
      teamId: team as TeamId,
      clusterAdmin: false,
      deletedAt: null
    };
    await admin.accounts.users.save(user);
    if (role === 'owner') await admin.accounts.teams.save({ id: team as TeamId, name: team, ownerId: user.id, createdAt: 1 });
    people[key] = { user, loginId: `l-${key}` as LoginId };
  };
  await mk('A', 't0', 'owner');
  await mk('O', 't1', 'owner');
  await mk('M', 't1', 'member');
  assets.projectList.set('p1', { id: 'p1', name: '项目一', teamId: 't1', createdBy: 'u-O', members: ['u-M'], deletedAt: null });
  const p = (key: string) => people[key]!;
  return { admin, assets, deps, p, audits: () => admin.entries };
}

const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

test('内置清单：每项都钉死版本、带来源和许可证；MCP 配置合法且不写明文密钥', () => {
  const ids = new Set<string>();
  for (const item of BUILTIN_ASSETS) {
    assert.ok(!ids.has(item.id), `重复的 id ${item.id}`);
    ids.add(item.id);
    assert.ok(item.version && item.source.license && item.source.url.startsWith('https://'), item.id);
    if (item.kind !== 'mcp') continue;
    const parsed = parseMcpAsset(item.files[0]!.text);
    assert.ok(parsed.ok, `${item.id}: ${parsed.ok ? '' : parsed.error.message}`);
    const text = item.files[0]!.text;
    // npm / PyPI 包都写确切版本，不用 latest
    for (const pkg of text.match(/@?[a-z0-9-]+\/?[a-z0-9-]*(?:@|==)[^"\s]+/g) ?? []) assert.match(pkg, /(@|==)\d/, `${item.id} 没钉版本：${pkg}`);
    assert.doesNotMatch(text, /latest/);
  }
  assert.ok(builtinById('playwright')?.files[0]?.text.includes('@playwright/mcp@0.0.85'));
  assert.equal(builtinById('playwright')?.requires?.browser, 'chromium');
});

test('一键启用：建项目级资产、来源记 builtin + 版本、直接发布、默认生效；再点只是打开开关', async () => {
  const w = await world();
  const before = must(await builtinAssetsFor(w.deps, w.p('M'), 'p1'));
  assert.equal(before.length, BUILTIN_ASSETS.length);
  assert.ok(before.every((item) => item.enabled === null));
  const made = must(await enableBuiltinAsset(w.deps, w.p('M'), { projectId: 'p1', builtinId: 'playwright' }));
  assert.equal(made.created, true);
  assert.equal(made.asset.scope, 'project');
  assert.deepEqual(made.asset.source, { type: 'builtin', id: 'playwright', version: '0.0.85' });
  assert.notEqual(made.asset.pinned, '', '内置的直接发布');
  const effective = resolveProjectAssets(await w.deps.assets.list(), 'p1', await w.deps.assets.projectSettings('p1')).effective;
  assert.ok(effective.some((asset) => asset.id === made.asset.id));
  assert.ok(w.audits().some((e) => e.action === 'asset.create' && e.detail.includes('启用内置资产')));
  // 关掉再启用：不重复建
  await w.deps.assets.setProjectSetting('p1', made.asset.id, false);
  const again = must(await enableBuiltinAsset(w.deps, w.p('M'), { projectId: 'p1', builtinId: 'playwright' }));
  assert.equal(again.created, false);
  assert.equal((await w.deps.assets.projectSettings('p1'))[made.asset.id], undefined, '恢复默认（开）');
  const view = must(await builtinAssetsFor(w.deps, w.p('M'), 'p1')).find((item) => item.id === 'playwright');
  assert.deepEqual(view?.enabled, { assetId: made.asset.id, version: '0.0.85', on: true, update: null });
});

test('要密钥的先填：没填拒绝并点名；只有团队负责人能存团队密钥；存了就能启用，值不进审计', async () => {
  const w = await world();
  const missing = await enableBuiltinAsset(w.deps, w.p('O'), { projectId: 'p1', builtinId: 'github' });
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? '' : missing.error.message, /GitHub 访问令牌/);
  const member = await enableBuiltinAsset(w.deps, w.p('M'), { projectId: 'p1', builtinId: 'github', secrets: { GITHUB_TOKEN: 'ghp_member' } });
  assert.equal(member.ok ? '' : member.error.code, 'forbidden');
  assert.match(member.ok ? '' : member.error.message, /团队负责人/);
  const extra = await enableBuiltinAsset(w.deps, w.p('O'), { projectId: 'p1', builtinId: 'github', secrets: { OTHER: 'x' } });
  assert.equal(extra.ok, false, '清单外的密钥名不收');
  const made = must(await enableBuiltinAsset(w.deps, w.p('O'), { projectId: 'p1', builtinId: 'github', secrets: { GITHUB_TOKEN: 'ghp_secret_value' } }));
  assert.equal(made.created, true);
  assert.ok((await w.deps.secrets.list()).some((s) => s.name === secretKey('team', 'GITHUB_TOKEN', 't1')));
  assert.ok(!JSON.stringify(w.audits()).includes('ghp_secret_value'));
  // 成员现在看得到「已填」，也能启用别的项目里的（同团队密钥）
  const view = must(await builtinAssetsFor(w.deps, w.p('M'), 'p1')).find((item) => item.id === 'github');
  assert.equal(view?.secrets[0]?.set, true);
});

test('同名资产：项目里已有同名的（不是这项内置）不能启用，不覆盖', async () => {
  const w = await world();
  const skill = [{ path: 'SKILL.md', data: enc('---\nname: web-testing\ndescription: 自己写的\n---\nhi\n') }];
  must(await submitNewAsset(w.deps, w.p('M'), { from: 'upload', kind: 'skill', scope: 'project', projectId: 'p1', files: skill }));
  const view = must(await builtinAssetsFor(w.deps, w.p('M'), 'p1')).find((item) => item.id === 'web-testing');
  assert.ok(view?.clash);
  const refused = await enableBuiltinAsset(w.deps, w.p('M'), { projectId: 'p1', builtinId: 'web-testing' });
  assert.equal(refused.ok ? '' : refused.error.code, 'conflict');
});

test('hub 升级后：已启用的保持锁住的版本并提示有新版本；主人点更新才换', async () => {
  const w = await world();
  const made = must(await enableBuiltinAsset(w.deps, w.p('M'), { projectId: 'p1', builtinId: 'web-testing' }));
  // 模拟「旧 hub 启用的」：锁在 0 版本、内容也不同
  const old = { ...made.asset, source: { type: 'builtin' as const, id: 'web-testing', version: '0' } };
  await w.deps.assets.update(old);
  const view = must(await builtinAssetsFor(w.deps, w.p('M'), 'p1')).find((item) => item.id === 'web-testing');
  assert.deepEqual([view?.enabled?.version, view?.enabled?.update], ['0', '1']);
  assert.equal((await w.deps.assets.get(made.asset.id))?.source.type === 'builtin' && (await w.deps.assets.get(made.asset.id))?.source, old.source, '没点更新就不动');
  const updated = must(await updateBuiltinAsset(w.deps, w.p('M'), made.asset.id));
  assert.deepEqual(updated.source, { type: 'builtin', id: 'web-testing', version: '1' });
  assert.equal((await updateBuiltinAsset(w.deps, w.p('M'), made.asset.id)).ok, false, '已经最新');
  assert.ok(w.audits().some((e) => e.action === 'asset.revision' && e.detail.includes('0 → 1')));
});

test('令牌不能启用内置资产；看不见的项目 404', async () => {
  const w = await world();
  const token: Principal = { ...w.p('O'), via: { tokenId: 't', name: 'ci', kind: 'personal', permissions: ['asset.submit'] as never } };
  assert.equal((await enableBuiltinAsset(w.deps, token, { projectId: 'p1', builtinId: 'context7' })).ok, false);
  const outsider = await builtinAssetsFor(w.deps, w.p('A'), 'p1');
  assert.equal(outsider.ok ? '' : outsider.error.code, 'not_found');
});
