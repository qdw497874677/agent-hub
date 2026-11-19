import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LoginId, Principal, TeamId, User, UserId } from '../account.ts';
import { resolveProjectAssets } from '../asset.ts';
import { BUILTIN_ASSETS, BUILTIN_CHROMIUM, builtinById } from '../builtin-assets.ts';
import type { CatalogComponent, WorkerComponentPin } from '../component-catalog.ts';
import type { RuntimeJob } from '../runtime-install.ts';
import type { WorkerStatus } from '../worker.ts';
import { parseMcpAsset, secretKey } from '../index.ts';
import { inMemoryAdmin, inMemoryAssetReviewDeps, inMemoryAssets } from '../testing/in-memory.ts';
import { submitNewAsset } from './asset-review.ts';
import { reviewComponent, submitComponent, type ComponentDeps } from './component-install.ts';
import { bootstrapBuiltinBrowserForSession, browserStatus, builtinAssetsFor, enableBuiltinAsset, installBuiltinBrowser, updateBuiltinAsset } from './builtin-assets.ts';

const enc = (text: string) => new TextEncoder().encode(text);

async function world(enrolledBy: Map<string, string> = new Map()) {
  const admin = inMemoryAdmin();
  const assets = inMemoryAssets();
  const { deps } = inMemoryAssetReviewDeps(admin, assets, enrolledBy);
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
  return { admin, assets, deps, p, audits: () => admin.entries, enrolledBy };
}

const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

const asToken = (actor: Principal, permissions: string[]): Principal =>
  ({ user: actor.user, via: { tokenId: 'tok-1', name: 'ci', kind: 'personal', permissions } }) as unknown as Principal;

const machine = (id: string, extra: Partial<WorkerStatus> = {}): WorkerStatus => ({
  workerId: id,
  label: id,
  origin: 'remote',
  state: 'online',
  agentIds: ['pi'],
  inventory: { runtimes: [{ agentId: 'pi', version: '0.1.0', source: 'machine' }], components: [], capabilities: [], collectedAt: 1, componentInstall: true },
  ...extra
});

/** 内置浏览器测试世界：资产中心 + 组件目录共用一份审计；registeredBy 记在 enrolledBy 里。 */
async function browserWorld(enrolled: Record<string, string> = {}) {
  const w = await world(new Map(Object.entries(enrolled)));
  const adminUser: User = {
    id: 'u-root' as UserId,
    email: 'root@x.co',
    displayName: 'root',
    role: 'owner',
    passwordHash: null,
    emailVerifiedAt: 1,
    disabledAt: null,
    createdAt: 1,
    teamId: 't0' as TeamId,
    clusterAdmin: true,
    deletedAt: null
  };
  await w.admin.accounts.users.save(adminUser);
  const root: Principal = { user: adminUser, loginId: 'l-root' as LoginId };
  const catalog = new Map<string, CatalogComponent>();
  const pins: WorkerComponentPin[] = [];
  const jobs: { id: string; job: RuntimeJob }[] = [];
  const workers: WorkerStatus[] = [];
  const component: ComponentDeps = {
    catalog: {
      list: async () => [...catalog.values()],
      byId: async (key) => catalog.get(key) ?? null,
      save: async (item) => void catalog.set(`${item.id}@${item.version}`, item)
    },
    pins: {
      pinsFor: (worker) => pins.filter((p) => p.workerId === worker),
      upsert: (pin) => {
        const i = pins.findIndex((p) => p.workerId === pin.workerId && p.componentId === pin.componentId);
        if (i >= 0) pins.splice(i, 1);
        pins.push(pin);
      },
      remove: (worker, id) => {
        const i = pins.findIndex((p) => p.workerId === worker && p.componentId === id);
        if (i >= 0) pins.splice(i, 1);
      }
    },
    workers: { list: async () => workers, runtimeJob: async (id, job) => (jobs.push({ id, job }), true) },
    sessions: { listAll: async () => [] },
    audit: w.deps.audit,
    access: w.deps.policy,
    resolveNpm: async (name, version) => ({
      name,
      version,
      resolved: `https://r/${name}-${version}.tgz`,
      integrity: BUILTIN_CHROMIUM.integrity,
      scripts: {},
      dependencyCount: 1
    }),
    now: () => 10,
    newJobId: () => 'job-1'
  };
  const deps = { ...w.deps, ...component };
  /** policy.worker 讀的是 assets.workers；deploy 同时更新 ComponentDeps 的机器清单和它。 */
  const deploy = (...machines: WorkerStatus[]) => {
    workers.splice(0, workers.length, ...machines);
    w.assets.workers.splice(0, w.assets.workers.length, ...machines.map((m) => ({ workerId: m.workerId, label: m.label, origin: m.origin, state: m.state })));
  };
  return { ...w, root, deps, workers, jobs, catalog, pins, deploy };
}

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

test('令牌启用内置资产：有 assets:write + 能改项目才能启用；只给 assets:submit 的旧令牌被拒；看不见的项目 404', async () => {
  const w = await world();
  // 可见性要 project.read；没有它连项目都看不见，直接 404
  const blind = asToken(w.p('O'), ['asset.submit', 'project.update']);
  const invisible = await enableBuiltinAsset(w.deps, blind, { projectId: 'p1', builtinId: 'playwright' });
  assert.equal(invisible.ok ? '' : invisible.error.code, 'not_found');
  const weak = asToken(w.p('O'), ['asset.submit', 'project.read']);
  const denied = await enableBuiltinAsset(w.deps, weak, { projectId: 'p1', builtinId: 'playwright' });
  assert.equal(denied.ok ? '' : denied.error.code, 'forbidden');
  const strong = asToken(w.p('O'), ['asset.submit', 'project.read', 'project.update']);
  const made = must(await enableBuiltinAsset(w.deps, strong, { projectId: 'p1', builtinId: 'playwright' }));
  assert.equal(made.created, true);
  assert.ok(w.audits().some((e) => e.action === 'asset.create' && e.detail.includes('经令牌 ci')));
  const outsider = asToken(w.p('A'), ['asset.submit', 'project.read', 'project.update']);
  const no = await enableBuiltinAsset(w.deps, outsider, { projectId: 'p1', builtinId: 'web-testing' });
  assert.equal(no.ok ? '' : no.error.code, 'not_found');
});

test('装内置浏览器：管理员令牌能扶植目录（提交→自准→装）；登记人令牌在目录齐了以后也能装', async () => {
  const w = await browserWorld({ w1: 'u-M' });
  w.deploy(machine('w1'));
  // 管理员的个人令牌：目录是空的 → 提交 + 批准 + 安装一气呵成
  const started = must(await installBuiltinBrowser(w.deps, asToken(w.root, []), 'w1'));
  assert.equal(started.component?.componentId, BUILTIN_CHROMIUM.componentId);
  assert.equal(w.jobs[0]?.id, 'w1');
  assert.ok(w.audits().some((e) => e.detail.includes('经令牌 ci')), '审计要记令牌');
  // 机器登记人的个人令牌：目录已经齐了，直接装
  const second = must(await installBuiltinBrowser(w.deps, asToken(w.p('M'), []), 'w1'));
  assert.equal(second.component?.componentId, BUILTIN_CHROMIUM.componentId);
  assert.equal(w.jobs.length, 2);
});

test('装内置浏览器：陌生人令牌不行；目录没齐时登记人拿到明确错误；本机令牌永远不行', async () => {
  const w = await browserWorld({ w1: 'u-M' });
  w.deploy(machine('w1'), machine('hub-local', { origin: 'local' }));
  const stranger = await installBuiltinBrowser(w.deps, asToken(w.p('A'), []), 'w1');
  assert.equal(stranger.ok ? '' : stranger.error.code, 'forbidden');
  const empty = await installBuiltinBrowser(w.deps, asToken(w.p('M'), []), 'w1');
  assert.match(empty.ok ? '' : empty.error.message, /集群管理员先/);
  const local = await installBuiltinBrowser(w.deps, asToken(w.root, []), 'hub-local');
  assert.equal(local.ok ? '' : local.error.code, 'forbidden');
  assert.match(local.ok ? '' : local.error.message, /本机/);
});

test('bootstrap：会话要浏览器时自动启用未配置的项目内置项，并挑能装的机器发起安装', async () => {
  const w = await browserWorld({ w1: 'u-M' });
  w.deploy(machine('w1'));
  // 目录里先有审核过的浏览器组件（管理员在界面或 MCP 上装过一次）；之后普通成员的会话也能自动装
  await submitComponent(w.deps, w.root, { id: BUILTIN_CHROMIUM.componentId, packageName: BUILTIN_CHROMIUM.packageName, version: BUILTIN_CHROMIUM.version, runtime: 'pi', provides: [{ capability: BUILTIN_CHROMIUM.capability, mode: BUILTIN_CHROMIUM.mode }] });
  const reviewed = await reviewComponent(w.deps, w.root, BUILTIN_CHROMIUM.componentId, BUILTIN_CHROMIUM.version, { approve: true, note: '内置浏览器（Playwright）' });
  assert.equal(reviewed.ok ? reviewed.value.status : '', 'approved');
  const out = await bootstrapBuiltinBrowserForSession(w.deps, w.deps, w.p('M'), { projectId: 'p1', requires: ['browser:chromium', 'tool:demo'] });
  assert.deepEqual([...out.enabled].sort(), ['playwright', 'web-testing']);
  assert.deepEqual(out.install, { workerId: 'w1', jobId: 'job-1' });
  const effective = resolveProjectAssets(await w.deps.assets.list(), 'p1', await w.deps.assets.projectSettings('p1')).effective;
  assert.ok(effective.some((a) => a.source.type === 'builtin' && a.source.id === 'playwright'));
  assert.ok(effective.some((a) => a.source.type === 'builtin' && a.source.id === 'web-testing'));
  assert.equal(w.jobs[0]?.job.component?.componentId, BUILTIN_CHROMIUM.componentId);
});

test('bootstrap：显式关掉的不强开；已经有就绪 / 在装机器时不重复装；没有能装的机器只提示不拦会话', async () => {
  const w = await browserWorld({ w1: 'u-M' });
  const made = must(await enableBuiltinAsset(w.deps, w.p('M'), { projectId: 'p1', builtinId: 'playwright' }));
  await w.deps.assets.setProjectSetting('p1', made.asset.id, false);
  w.deploy(machine('w1', { drift: { items: [], trusted: [{ capability: 'browser:chromium', via: 'chromium' }], untrusted: [] } }));
  const ready = await bootstrapBuiltinBrowserForSession(w.deps, w.deps, w.p('M'), { projectId: 'p1', requires: ['browser:chromium'] });
  // playwright 显式关掉的不重开；web-testing 没配置过，照常自动启用
  assert.deepEqual(ready.enabled, ['web-testing']);
  assert.equal(ready.install, undefined);
  assert.equal(ready.skipped, undefined, '有就绪机器就不说话');
  // 已经有一台在装：不再发任务
  w.deploy(
    machine('w2', {
      runtimeJob: {
        jobId: 'j0',
        agentId: 'pi',
        action: 'install_component',
        version: null,
        component: { componentId: 'chromium', runtime: 'pi', packageName: 'playwright-core', version: BUILTIN_CHROMIUM.version, resolved: '', integrity: BUILTIN_CHROMIUM.integrity, provides: [{ capability: BUILTIN_CHROMIUM.capability, mode: BUILTIN_CHROMIUM.mode }], ignoreScripts: true, expectedCurrent: null },
        state: 'running',
        message: '',
        log: '',
        startedAt: 1,
        endedAt: null,
        actorEmail: 'root@b.co'
      }
    })
  );
  const installing = await bootstrapBuiltinBrowserForSession(w.deps, w.deps, w.p('M'), { projectId: 'p1', requires: ['browser:chromium'] });
  assert.match(installing.skipped ?? '', /正在安装/);
  assert.equal(w.jobs.length, 0);
  // 没有任何机器能装（太旧 / 没有 pi / 不在线）：只给提示，不抛错
  w.deploy(machine('old', { inventory: { runtimes: [], components: [], capabilities: [], collectedAt: 1, componentInstall: false } }));
  const blocked = await bootstrapBuiltinBrowserForSession(w.deps, w.deps, w.p('M'), { projectId: 'p1', requires: ['browser:chromium'] });
  assert.match(blocked.skipped ?? '', /没有能装 Chromium 的在线机器/);
});

test('bootstrap：会话不要求浏览器就什么都不做；浏览器状态视图带最近安装任务', async () => {
  const w = await browserWorld();
  const idle = await bootstrapBuiltinBrowserForSession(w.deps, w.deps, w.p('M'), { projectId: 'p1', requires: ['tool:demo'] });
  assert.deepEqual(idle.enabled, []);
  assert.equal(idle.install, undefined);
  assert.equal(w.jobs.length, 0);
  w.deploy(
    machine('w1', {
      runtimeJob: {
        jobId: 'j9',
        agentId: 'pi',
        action: 'install_component',
        version: null,
        component: { componentId: 'chromium', runtime: 'pi', packageName: 'playwright-core', version: BUILTIN_CHROMIUM.version, resolved: '', integrity: BUILTIN_CHROMIUM.integrity, provides: [{ capability: BUILTIN_CHROMIUM.capability, mode: BUILTIN_CHROMIUM.mode }], ignoreScripts: true, expectedCurrent: null },
        state: 'failed',
        message: '缺系统库',
        log: '',
        startedAt: 1,
        endedAt: 2,
        actorEmail: 'root@b.co'
      }
    })
  );
  const status = browserStatus(w.workers).find((row) => row.workerId === 'w1');
  assert.deepEqual(status?.installJob, { jobId: 'j9', state: 'failed', message: '缺系统库' }, '失败的任务也要露出来');
  assert.equal(status?.blocker, null);
});
