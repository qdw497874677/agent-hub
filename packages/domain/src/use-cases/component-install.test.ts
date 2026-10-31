import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Principal, User, UserId, AuditEntry, HubSettings } from '../account.ts';
import { NEVER_GRANTABLE, ROLE_PERMISSIONS, type Resource } from '../access.ts';
import type { CatalogComponent, NpmArtifactInfo, WorkerComponentPin } from '../component-catalog.ts';
import type { RuntimeJob } from '../runtime-install.ts';
import { placeSession, type WorkerStatus } from '../worker.ts';
import type { AccessPolicy } from './authorization.ts';
import { inventoryViewer, redactInventory } from './authorization.ts';
import { componentJobFinished, listComponentCatalog, reviewComponent, startComponentJob, submitComponent, type ComponentDeps } from './component-install.ts';

const person = (id: string, role: User['role'], clusterAdmin = false): Principal =>
  ({
    user: { id: id as UserId, email: `${id}@b.co`, displayName: id, role, passwordHash: null, emailVerifiedAt: 1, disabledAt: null, createdAt: 1, teamId: 'team' as User['teamId'], clusterAdmin, deletedAt: null },
    login: { id: `l-${id}`, userId: id as UserId, tokenHash: 'h', method: 'password', userAgent: null, ip: null, createdAt: 1, lastSeenAt: 1, expiresAt: 9e15 }
  }) as unknown as Principal;

const david = person('david', 'owner', true);
const member = person('m', 'member');
const stranger = person('x', 'member');
const INTEGRITY = `sha512-${'a'.repeat(86)}==`;

function machine(id: string, extra: Partial<WorkerStatus> = {}): WorkerStatus {
  return {
    workerId: id, label: id, origin: 'remote', state: 'online', agentIds: ['pi'],
    inventory: { runtimes: [{ agentId: 'pi', version: '0.1.0', source: 'machine' }], components: [], capabilities: [], collectedAt: 1, componentInstall: true },
    ...extra
  };
}

function setup(artifact: Partial<NpmArtifactInfo> = {}) {
  const catalog = new Map<string, CatalogComponent>();
  const pins: WorkerComponentPin[] = [];
  const entries: AuditEntry[] = [];
  const jobs: { id: string; job: RuntimeJob }[] = [];
  const workers: WorkerStatus[] = [];
  const settings: HubSettings = { openRegistration: false, membersCanAddMachines: true, refuseWhenFull: [] };
  const access: AccessPolicy = {
    context: async () => ({ hubTeamId: 'team', settings }),
    worker: async (id): Promise<Resource> => (id === null ? { kind: 'worker', teamId: 'team', local: true } : { kind: 'worker', id, teamId: 'team', createdBy: 'm' })
  };
  const deps: ComponentDeps = {
    catalog: { list: async () => [...catalog.values()], byId: async (key) => catalog.get(key) ?? null, save: async (item) => void catalog.set(`${item.id}@${item.version}`, item) },
    pins: {
      pinsFor: (w) => pins.filter((p) => p.workerId === w),
      upsert: (pin) => {
        const i = pins.findIndex((p) => p.workerId === pin.workerId && p.componentId === pin.componentId);
        if (i >= 0) pins.splice(i, 1);
        pins.push(pin);
      },
      remove: (w, c) => {
        const i = pins.findIndex((p) => p.workerId === w && p.componentId === c);
        if (i >= 0) pins.splice(i, 1);
      }
    },
    workers: { list: async () => workers, runtimeJob: async (id, job) => (jobs.push({ id, job }), true) },
    sessions: { listAll: async () => [] },
    settings: { get: async () => settings },
    audit: { append: async (e) => void entries.unshift(e), recent: async () => entries, query: async () => entries },
    access,
    resolveNpm: async (name, version) => ({ name, version, resolved: `https://r/${name}-${version}.tgz`, integrity: INTEGRITY, scripts: { postinstall: 'node x.js' }, dependencyCount: 2, ...artifact }),
    now: () => 10,
    newJobId: () => 'job-1'
  };
  return { deps, catalog, pins, entries, jobs, workers, settings };
}

const submission = { id: 'demo', packageName: 'demo-pi-ext', version: '1.0.0', provides: [{ capability: 'tool:demo' }] };

test('runtime.component.install：成员只对自己接入的机器有，且永远不能单独授予 / 进自定义角色', () => {
  assert.equal(ROLE_PERMISSIONS.member['runtime.component.install'], 'own');
  assert.ok(NEVER_GRANTABLE.has('runtime.component.install'));
});

test('只有集群管理员能提交、审核；提交时 hub 钉死制品并把安装脚本带上', async () => {
  const { deps, entries } = setup();
  const denied = await submitComponent(deps, member, submission);
  assert.equal(!denied.ok && denied.error.code, 'forbidden');
  const submitted = await submitComponent(deps, david, submission);
  assert.ok(submitted.ok);
  assert.equal(submitted.value.status, 'pending');
  assert.equal(submitted.value.integrity, INTEGRITY);
  assert.deepEqual(submitted.value.scripts, { postinstall: 'node x.js' });
  assert.equal(entries[0]?.action, 'bundle.submit');
  assert.match(entries[0]!.detail, /postinstall/);
  const again = await submitComponent(deps, david, submission);
  assert.equal(!again.ok && again.error.code, 'conflict');
  assert.equal((await reviewComponent(deps, member, 'demo', '1.0.0', { approve: true })).ok, false);
  const approved = await reviewComponent(deps, david, 'demo', '1.0.0', { approve: true, note: '看过脚本' });
  assert.ok(approved.ok);
  assert.equal(entries[0]?.action, 'bundle.review');
  assert.equal((await reviewComponent(deps, david, 'demo', '1.0.0', { approve: false })).ok, false, '审过的不能再审');
});

test('registry 回的版本 / 包名对不上 → 拒绝提交', async () => {
  const { deps } = setup({ version: '1.0.1' });
  const result = await submitComponent(deps, david, submission);
  assert.equal(result.ok, false);
});

test('目录：集群管理员看全部，其他人只看已批准的', async () => {
  const { deps } = setup();
  await submitComponent(deps, david, submission);
  await submitComponent(deps, david, { ...submission, version: '1.1.0' });
  await reviewComponent(deps, david, 'demo', '1.0.0', { approve: true });
  const all = await listComponentCatalog(deps, david);
  const mine = await listComponentCatalog(deps, member);
  assert.ok(all.ok && mine.ok);
  assert.equal(all.value.length, 2);
  assert.deepEqual(mine.value.map((c) => c.version), ['1.0.0']);
  assert.equal((await listComponentCatalog(deps, null)).ok, false);
});

test('装组件：没审过的不行；成员能装自己的机器，别人的不行；禁止安装脚本 → ignoreScripts', async () => {
  const { deps, jobs, entries, workers, settings } = setup();
  workers.push(machine('w1'));
  await submitComponent(deps, david, submission);
  const pending = await startComponentJob(deps, member, 'w1', { componentId: 'demo', version: '1.0.0', action: 'install_component' });
  assert.equal(!pending.ok && pending.error.code, 'conflict');
  await reviewComponent(deps, david, 'demo', '1.0.0', { approve: true });
  const other = await startComponentJob(deps, stranger, 'w1', { componentId: 'demo', version: '1.0.0', action: 'install_component' });
  assert.equal(!other.ok && other.error.code, 'forbidden');
  const ok = await startComponentJob(deps, member, 'w1', { componentId: 'demo', version: '1.0.0', action: 'install_component' });
  assert.ok(ok.ok, !ok.ok ? ok.error.message : '');
  assert.equal(jobs[0]?.job.component?.ignoreScripts, false);
  assert.equal(jobs[0]?.job.component?.expectedCurrent, null);
  assert.equal(entries[0]?.action, 'runtime.component.install');
  (settings as { disableInstallScripts?: boolean }).disableInstallScripts = true;
  await startComponentJob(deps, member, 'w1', { componentId: 'demo', version: '1.0.0', action: 'install_component' });
  assert.equal(jobs[1]?.job.component?.ignoreScripts, true);
  assert.match(entries[0]!.detail, /禁止安装脚本/);
});

test('老 Worker（不报 componentInstall）不发组件任务', async () => {
  const { deps, workers } = setup();
  workers.push(machine('old', { inventory: { runtimes: [], components: [], capabilities: [], collectedAt: 1 } }));
  await submitComponent(deps, david, submission);
  await reviewComponent(deps, david, 'demo', '1.0.0', { approve: true });
  const result = await startComponentJob(deps, david, 'old', { componentId: 'demo', version: '1.0.0', action: 'install_component' });
  assert.equal(!result.ok && result.error.code, 'conflict');
});

test('任务结束：成功写钉住、脚本逐条审计；哈希不符记审计且不写钉住；卸载删钉住', async () => {
  const { deps, pins, entries } = setup();
  const base: RuntimeJob = {
    jobId: 'j', agentId: 'pi', action: 'install_component', version: '1.0.0', state: 'succeeded', message: '', log: '', startedAt: 1, endedAt: 2, actorEmail: 'm@b.co',
    component: { componentId: 'demo', runtime: 'pi', packageName: 'demo-pi-ext', version: '1.0.0', resolved: 'https://r/x.tgz', integrity: INTEGRITY, provides: [], ignoreScripts: false, expectedCurrent: null },
    result: { scripts: [{ package: 'demo-pi-ext', script: 'postinstall' }, { package: 'dep', script: 'install' }] }
  };
  await componentJobFinished(deps, 'w1', base);
  assert.equal(pins.length, 1);
  assert.equal(pins[0]?.version, '1.0.0');
  assert.deepEqual(entries.filter((e) => e.action === 'bundle.script_run').map((e) => e.detail).sort(), ['demo-pi-ext postinstall', 'dep install']);
  await componentJobFinished(deps, 'w2', { ...base, state: 'failed', result: { integrityMismatch: true, integrity: 'sha512-zzz' } });
  assert.equal(entries[0]?.action, 'bundle.integrity_mismatch');
  assert.equal(pins.filter((p) => p.workerId === 'w2').length, 0);
  await componentJobFinished(deps, 'w1', { ...base, action: 'uninstall_component', result: {} });
  assert.equal(pins.length, 0);
});

test('调度：requires 只认可信能力；漂移的不算；指定机器缺能力 → conflict', () => {
  const cap = { capability: 'tool:demo', via: 'demo' };
  const good = machine('good', { drift: { items: [], trusted: [cap], untrusted: [] } });
  const drifted = machine('drifted', { drift: { items: [], trusted: [], untrusted: [cap] } });
  assert.deepEqual(placeSession([drifted, good], { agentId: 'pi', requested: null, projectWorker: null, requires: ['tool:demo'] }), { ok: true, value: 'good' });
  const pinned = placeSession([drifted, good], { agentId: 'pi', requested: 'drifted', projectWorker: null, requires: ['tool:demo'] });
  assert.equal(!pinned.ok && pinned.error.code, 'conflict');
  const none = placeSession([drifted], { agentId: 'pi', requested: null, projectWorker: null, requires: ['tool:demo'] });
  assert.equal(none.ok, false);
  assert.ok(placeSession([drifted], { agentId: 'pi', requested: null, projectWorker: null }).ok, '不要求能力时照旧');
});

test('清单可见性：能装的人看全量；其他人看不到外部组件的包名 / 来源', async () => {
  const { deps } = setup();
  const worker = machine('w1', {
    inventory: { runtimes: [], components: [{ id: 'some-ext', runtime: 'pi', version: '1', managedBy: 'external', enabled: true, source: 'npm:some-ext@1' } as never], capabilities: [], collectedAt: 1, componentInstall: true },
    drift: { items: [{ kind: 'external', componentId: 'some-ext', runtime: 'pi' } as never], trusted: [], untrusted: [] }
  });
  const viewer = await inventoryViewer(deps.access, stranger);
  assert.equal(await viewer(worker), false);
  assert.equal(await (await inventoryViewer(deps.access, member))(worker), true);
  const redacted = redactInventory(worker);
  assert.equal(redacted.inventory, undefined);
  assert.deepEqual(redacted.drift?.items, []);
  assert.doesNotMatch(JSON.stringify(redacted), /some-ext/);
});
