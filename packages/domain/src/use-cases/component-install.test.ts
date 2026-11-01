import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Principal, User, UserId, AuditEntry, HubSettings } from '../account.ts';
import { NEVER_GRANTABLE, ROLE_PERMISSIONS, type Resource } from '../access.ts';
import type { CatalogComponent, NpmArtifactInfo, WorkerComponentPin } from '../component-catalog.ts';
import type { RuntimeJob } from '../runtime-install.ts';
import { placeSession, type WorkerStatus } from '../worker.ts';
import type { AccessPolicy } from './authorization.ts';
import { inventoryViewer, redactInventory } from './authorization.ts';
import { componentJobFinished, listComponentCatalog, reviewComponent, startBundleJob, startComponentJob, submitComponent, type ComponentDeps } from './component-install.ts';

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

test('装组件：没审过的不行；成员能装自己的机器，别人的不行；安装脚本一律不执行（ignoreScripts 恒为 true）', async () => {
  const { deps, jobs, entries, workers } = setup();
  workers.push(machine('w1'));
  await submitComponent(deps, david, submission);
  const pending = await startComponentJob(deps, member, 'w1', { componentId: 'demo', version: '1.0.0', action: 'install_component' });
  assert.equal(!pending.ok && pending.error.code, 'conflict');
  await reviewComponent(deps, david, 'demo', '1.0.0', { approve: true });
  const other = await startComponentJob(deps, stranger, 'w1', { componentId: 'demo', version: '1.0.0', action: 'install_component' });
  assert.equal(!other.ok && other.error.code, 'forbidden');
  const ok = await startComponentJob(deps, member, 'w1', { componentId: 'demo', version: '1.0.0', action: 'install_component' });
  assert.ok(ok.ok, !ok.ok ? ok.error.message : '');
  assert.equal(jobs[0]?.job.component?.ignoreScripts, true);
  assert.equal(jobs[0]?.job.component?.expectedCurrent, null);
  assert.equal(entries[0]?.action, 'runtime.component.install');
});

test('老 Worker（不报 componentInstall）不发组件任务', async () => {
  const { deps, workers } = setup();
  workers.push(machine('old', { inventory: { runtimes: [], components: [], capabilities: [], collectedAt: 1 } }));
  await submitComponent(deps, david, submission);
  await reviewComponent(deps, david, 'demo', '1.0.0', { approve: true });
  const result = await startComponentJob(deps, david, 'old', { componentId: 'demo', version: '1.0.0', action: 'install_component' });
  assert.equal(!result.ok && result.error.code, 'conflict');
});

test('任务结束：成功写钉住、没执行的脚本逐条审计；哈希不符记审计且不写钉住；卸载删钉住', async () => {
  const { deps, pins, entries } = setup();
  const base: RuntimeJob = {
    jobId: 'j', agentId: 'pi', action: 'install_component', version: '1.0.0', state: 'succeeded', message: '', log: '', startedAt: 1, endedAt: 2, actorEmail: 'm@b.co',
    component: { componentId: 'demo', runtime: 'pi', packageName: 'demo-pi-ext', version: '1.0.0', resolved: 'https://r/x.tgz', integrity: INTEGRITY, provides: [], ignoreScripts: true, expectedCurrent: null },
    result: { scripts: [{ package: 'demo-pi-ext', script: 'postinstall' }, { package: 'dep', script: 'install' }] }
  };
  await componentJobFinished(deps, 'w1', base);
  assert.equal(pins.length, 1);
  assert.equal(pins[0]?.version, '1.0.0');
  assert.deepEqual(entries.filter((e) => e.action === 'bundle.script_skipped').map((e) => e.detail).sort(), ['demo-pi-ext postinstall（未执行）', 'dep install（未执行）']);
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

test('双人审核（P3）：要求 2 人时提交人不能批，同一人不能批两次，凑够才 approved；驳回一票即止', async () => {
  const { deps } = setup();
  const strict = { ...deps, requiredApprovals: 2 };
  const alice = person('alice', 'owner', true);
  const bob = person('bob', 'owner', true);
  assert.ok((await submitComponent(strict, david, submission)).ok);
  const self = await reviewComponent(strict, david, 'demo', '1.0.0', { approve: true });
  assert.equal(!self.ok && self.error.code, 'forbidden');
  const first = await reviewComponent(strict, alice, 'demo', '1.0.0', { approve: true });
  assert.ok(first.ok);
  assert.equal(first.value.status, 'pending');
  assert.equal(first.value.approvals?.length, 1);
  const twice = await reviewComponent(strict, alice, 'demo', '1.0.0', { approve: true });
  assert.equal(!twice.ok && twice.error.code, 'conflict');
  const second = await reviewComponent(strict, bob, 'demo', '1.0.0', { approve: true });
  assert.ok(second.ok);
  assert.equal(second.value.status, 'approved');
  assert.equal(second.value.reviewedBy, 'bob@b.co');
  assert.ok((await submitComponent(strict, david, { ...submission, version: '1.1.0' })).ok);
  const rejected = await reviewComponent(strict, alice, 'demo', '1.1.0', { approve: false, note: '不行' });
  assert.equal(rejected.ok && rejected.value.status, 'rejected');
  // 默认 1 人：提交人自己批也行（P2 行为不变）
  assert.ok((await submitComponent(deps, david, { ...submission, id: 'solo' })).ok);
  assert.equal((await reviewComponent(deps, david, 'solo', '1.0.0', { approve: true })).ok, true);
});

test('git 来源（P4）：必须 https + 40 位提交号；不查 registry；integrity 是 git:<commit>；opencode 运行时', async () => {
  const { deps } = setup();
  let asked = 0;
  const counting = { ...deps, resolveNpm: async (n: string, v: string) => (asked++, deps.resolveNpm(n, v)) };
  const commit = 'c'.repeat(40);
  const branch = await submitComponent(counting, david, { ...submission, git: { url: 'https://github.com/o/r.git', commit: 'main' } });
  assert.equal(!branch.ok && branch.error.code, 'invalid');
  const creds = await submitComponent(counting, david, { ...submission, git: { url: 'https://u:p@github.com/o/r.git', commit } });
  assert.equal(creds.ok, false);
  const ok = await submitComponent(counting, david, { ...submission, id: 'oc', runtime: 'opencode', git: { url: 'https://github.com/o/r.git', commit } });
  assert.ok(ok.ok);
  assert.equal(asked, 0);
  assert.equal(ok.value.integrity, `git:${commit}`);
  assert.equal(ok.value.resolved, `git+https://github.com/o/r.git#${commit}`);
  assert.equal(ok.value.runtime, 'opencode');
  const switched = await submitComponent(counting, david, { ...submission, id: 'oc', version: '1.0.1', runtime: 'pi', git: { url: 'https://github.com/o/r.git', commit } });
  assert.equal(!switched.ok && switched.error.code, 'conflict');
});

test('整套安装（P3）：每项按单装规则检查，一项不行整体拒绝；已装好的跳过；只发给报了 bundleInstall 的 Worker', async () => {
  const { deps, workers, jobs, pins } = setup();
  for (const id of ['a', 'b', 'c']) {
    assert.ok((await submitComponent(deps, david, { ...submission, id, packageName: `${id}-pkg` })).ok);
    if (id !== 'c') assert.ok((await reviewComponent(deps, david, id, '1.0.0', { approve: true })).ok);
  }
  const old = machine('w1');
  workers.push(old);
  const tooOld = await startBundleJob(deps, member, 'w1', { components: [{ componentId: 'a', version: '1.0.0' }] });
  assert.equal(!tooOld.ok && tooOld.error.code, 'conflict');
  workers[0] = { ...old, inventory: { ...old.inventory!, bundleInstall: true } };
  const withPending = await startBundleJob(deps, member, 'w1', { components: [{ componentId: 'a', version: '1.0.0' }, { componentId: 'c', version: '1.0.0' }] });
  assert.ok(!withPending.ok && /^c：/.test(withPending.error.message));
  assert.equal(jobs.length, 0);
  const job = await startBundleJob(deps, member, 'w1', { components: [{ componentId: 'a', version: '1.0.0' }, { componentId: 'b', version: '1.0.0' }] });
  assert.ok(job.ok);
  assert.deepEqual(job.value.components?.map((c) => c.componentId), ['a', 'b']);
  assert.ok(job.value.components?.every((c) => c.ignoreScripts === true && c.expectedCurrent === null));
  await componentJobFinished(deps, 'w1', { ...job.value, state: 'succeeded' });
  assert.deepEqual(pins.map((p) => p.componentId).sort(), ['a', 'b']);
  const dup = await startBundleJob(deps, member, 'w1', { components: [{ componentId: 'a', version: '1.0.0' }, { componentId: 'a', version: '1.0.0' }] });
  assert.equal(!dup.ok && dup.error.code, 'invalid');
});
