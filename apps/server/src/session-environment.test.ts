import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '@agent-hub/domain';
import { asAgentId } from '@agent-hub/domain';
import {
  createProjectUseCase,
  createTaskUseCase,
  deriveSession,
  ensureHosted,
  pinAssetRevision,
  setSecret,
  startCommand,
  uploadAsset,
  uploadAssetRevision
} from '@agent-hub/domain';
import { inMemoryAssets, inMemoryDeps } from '@agent-hub/domain/testing';
import { createSessionEnvironment } from './session-environment.ts';

const enc = (text: string) => new TextEncoder().encode(text);
const skillFiles = () => [
  { path: 'SKILL.md', data: enc('---\nname: greeter\ndescription: Greets\n---\nhi\n') },
  { path: 'scripts/x.txt', data: enc('helper') }
];
const mcpFiles = (value: unknown) => [{ path: 'mcp.json', data: enc(JSON.stringify(value)) }];

async function world() {
  const assets = inMemoryAssets();
  const hub = inMemoryDeps();
  const project = await createProjectUseCase(hub.deps, { name: 'env', rootPath: '/tmp/env' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(hub.deps, { projectId: project.value.id, title: '环境' });
  assert.ok(task.ok);
  const made = deriveSession({
    task: task.value,
    agentId: asAgentId('fake'),
    model: '',
    now: 1,
    workerId: 'w1'
  });
  assert.ok(made.ok);
  return { assets, hub, project: project.value, task: task.value, session: made.value };
}

test('会话环境版本：prepare 落库的版本与随后 revision() 相同', async () => {
  const { assets, hub, session } = await world();
  const uploaded = await uploadAsset(assets.deps, { kind: 'skill', files: skillFiles() });
  assert.ok(uploaded.ok);
  await assets.deps.assets.install('w1', uploaded.value.id, 1);
  assets.board.set('w1', {
    workerId: 'w1',
    state: 'synced',
    root: '/r',
    installed: { [uploaded.value.id]: uploaded.value.pinned },
    error: null,
    at: 1
  });

  const environment = createSessionEnvironment({
    assetDeps: assets.deps,
    tasks: hub.deps.tasks,
    projects: hub.deps.projects
  });
  const command = startCommand({ ...session, workerId: 'w1' }, '/tmp/env', null);
  const prepared = await environment.prepare(command);
  assert.equal(prepared.blocked, undefined);
  assert.ok(prepared.revision);
  assert.deepEqual(prepared.command.kind === 'start_session' ? prepared.command.assetIds : null, [uploaded.value.id]);

  const first = await environment.revision({ ...session, workerId: 'w1' });
  const second = await environment.revision({ ...session, workerId: 'w1' });
  assert.equal(first, prepared.revision);
  assert.equal(second, prepared.revision);
});

test('#225：启用 MCP 资产、这次没给 tools 时版本一致，连续两次投递都不再判 stale', async () => {
  const { assets, hub, session } = await world();
  const secrets = assets.deps.secrets;
  let boom = false;
  const assetDeps = {
    ...assets.deps,
    secrets: {
      ...secrets,
      reveal: async (names: readonly string[]) => {
        if (boom) throw new Error('密钥解密失败');
        return secrets.reveal(names);
      }
    }
  };
  const mcp = await uploadAsset(assetDeps, {
    kind: 'mcp',
    files: mcpFiles({ name: 'local-fs', command: 'node', args: ['srv.js'], env: { FS_TOKEN: '${secret:FS_TOKEN}' } })
  });
  assert.ok(mcp.ok);
  await assetDeps.assets.install('w1', mcp.value.id, 1);
  assert.ok((await setSecret(assetDeps, 'FS_TOKEN', 'fs-value')).ok);

  const environment = createSessionEnvironment({
    assetDeps,
    tasks: hub.deps.tasks,
    projects: hub.deps.projects
  });
  // 工具端点这次没签发成功：命令里没有 tools（见 tool-gateway.ts）。
  const command = startCommand({ ...session, workerId: 'w1' }, '/tmp/env', null);
  const prepared = await environment.prepare(command);
  assert.equal(prepared.blocked, undefined);
  assert.ok(prepared.revision);
  assert.equal(prepared.command.kind === 'start_session' ? prepared.command.tools : 'x', undefined);
  assert.equal(prepared.command.kind === 'start_session' ? prepared.command.mcp : 'x', undefined);

  const withRevision: Session = { ...session, workerId: 'w1', environmentRevision: prepared.revision };
  await hub.deps.sessions.save(withRevision);
  // prepare 之后密钥就读不出来了：revision() 只能靠记录，不能再解密。
  boom = true;
  assert.equal(await environment.revision(withRevision), prepared.revision);
  assert.equal(await environment.revision(withRevision), prepared.revision);

  const deps = { ...hub.deps, environment };
  hub.deps.hosting.add(withRevision.id, 'w1');
  hub.dispatched.length = 0;
  assert.ok((await ensureHosted(deps, withRevision)).ok);
  assert.ok((await ensureHosted(deps, withRevision)).ok);
  assert.equal(hub.dispatched.length, 0);
});

test('#223：资产展开抛错时不下发会话（fail-closed，不是「全给」）', async () => {
  const { assets, hub, session } = await world();
  const assetDeps = {
    ...assets.deps,
    secrets: {
      ...assets.deps.secrets,
      reveal: async () => {
        throw new Error('密钥解密失败');
      }
    }
  };
  const mcp = await uploadAsset(assetDeps, {
    kind: 'mcp',
    files: mcpFiles({ name: 'local-fs', command: 'node', args: ['srv.js'], env: { FS_TOKEN: '${secret:FS_TOKEN}' } })
  });
  assert.ok(mcp.ok);
  await assets.deps.assets.install('w1', mcp.value.id, 1);
  assert.ok((await setSecret(assets.deps, 'FS_TOKEN', 'fs-value')).ok);

  const environment = createSessionEnvironment({
    assetDeps,
    tasks: hub.deps.tasks,
    projects: hub.deps.projects
  });
  const command = startCommand({ ...session, workerId: 'w1' }, '/tmp/env', null);
  const prepared = await environment.prepare({ ...command, tools: { transport: 'relay', url: 'http://hub/mcp', token: 't' } });
  assert.equal(prepared.revision, null);
  assert.match(prepared.blocked ?? '', /会话资产没有准备好：密钥解密失败/);
  // 就算调用方漏看 blocked，命令也带显式空集——绝不退回「不带 assetIds = 全给」。
  assert.deepEqual(prepared.command.kind === 'start_session' ? prepared.command.assetIds : 'x', []);
  // 被 blocked 的启动不算真正开始第一轮：不写权威快照。
  assert.equal(await assets.deps.assets.sessionAssetSnapshot(session.id), null);
});

test('#223：容器会话解析不到项目时不下发会话', async () => {
  const { assets, hub, session } = await world();
  const environment = createSessionEnvironment({
    assetDeps: assets.deps,
    tasks: hub.deps.tasks,
    projects: hub.deps.projects,
    containerProject: async () => null
  });
  const command = startCommand({ ...session, taskId: null, workerId: 'w1' }, '/tmp/env', null);
  const prepared = await environment.prepare(command);
  assert.equal(prepared.revision, null);
  assert.match(prepared.blocked ?? '', /会话资产没有准备好/);
  assert.deepEqual(prepared.command.kind === 'start_session' ? prepared.command.assetIds : 'x', []);
});

test('#226：首次启动写权威快照；换钉后重新托管仍按旧 digest', async () => {
  const { assets, hub, session } = await world();
  const uploaded = await uploadAsset(assets.deps, { kind: 'skill', files: skillFiles() });
  assert.ok(uploaded.ok);
  const assetId = uploaded.value.id;
  const oldDigest = uploaded.value.pinned;
  await assets.deps.assets.install('w1', assetId, 1);
  assets.board.set('w1', {
    workerId: 'w1',
    state: 'synced',
    root: '/r',
    installed: { [assetId]: oldDigest },
    error: null,
    at: 1
  });

  const environment = createSessionEnvironment({ assetDeps: assets.deps, tasks: hub.deps.tasks, projects: hub.deps.projects });
  const command = startCommand({ ...session, workerId: 'w1' }, '/tmp/env', null);
  const first = await environment.prepare(command);
  assert.equal(first.blocked, undefined);
  const snapshot = await assets.deps.assets.sessionAssetSnapshot(session.id);
  assert.equal(snapshot?.mode, 'snapshot');
  assert.equal(snapshot?.source, 'project');
  assert.deepEqual(
    snapshot?.entries.map((entry) => [entry.assetId, entry.digest]),
    [[assetId, oldDigest]]
  );

  // 资产换了新版本并被钉住、Worker 也同步到了新版本。
  const revised = await uploadAssetRevision(assets.deps, assetId, [
    { path: 'SKILL.md', data: enc('---\nname: greeter\ndescription: Greets\n---\nnew\n') },
    { path: 'scripts/x.txt', data: enc('helper') }
  ]);
  assert.ok(revised.ok);
  const newDigest = revised.value.asset.latest;
  assert.notEqual(newDigest, oldDigest);
  assert.ok((await pinAssetRevision(assets.deps, assetId, newDigest)).ok);
  assets.board.set('w1', {
    workerId: 'w1',
    state: 'synced',
    root: '/r',
    installed: { [assetId]: newDigest },
    error: null,
    at: 2
  });

  // 重新托管（再 prepare）：仍按首次快照，不跟随实时生效集。
  const again = await environment.prepare(command);
  assert.equal(again.blocked, undefined);
  assert.equal(again.revision, first.revision);
  assert.deepEqual(again.command.kind === 'start_session' ? again.command.assetIds : null, [assetId]);
  const kept = await assets.deps.assets.sessionAssetSnapshot(session.id);
  assert.equal(kept?.at, snapshot?.at);
  assert.deepEqual(kept?.entries.map((entry) => entry.digest), [oldDigest]);
  assert.equal(await environment.revision({ ...session, workerId: 'w1' }), first.revision);
});

test('#226：显式升级后切到新 digest，下一次 prepare 用新快照', async () => {
  const { assets, hub, session } = await world();
  const uploaded = await uploadAsset(assets.deps, { kind: 'skill', files: skillFiles() });
  assert.ok(uploaded.ok);
  const assetId = uploaded.value.id;
  const oldDigest = uploaded.value.pinned;
  await assets.deps.assets.install('w1', assetId, 1);
  assets.board.set('w1', { workerId: 'w1', state: 'synced', root: '/r', installed: { [assetId]: oldDigest }, error: null, at: 1 });
  const environment = createSessionEnvironment({ assetDeps: assets.deps, tasks: hub.deps.tasks, projects: hub.deps.projects });
  const command = startCommand({ ...session, workerId: 'w1' }, '/tmp/env', null);
  const first = await environment.prepare(command);
  assert.ok(first.revision);

  const revised = await uploadAssetRevision(assets.deps, assetId, [
    { path: 'SKILL.md', data: enc('---\nname: greeter\ndescription: Greets\n---\nnew\n') },
    { path: 'scripts/x.txt', data: enc('helper') }
  ]);
  assert.ok(revised.ok);
  const newDigest = revised.value.asset.latest;
  assert.ok((await pinAssetRevision(assets.deps, assetId, newDigest)).ok);
  assets.board.set('w1', { workerId: 'w1', state: 'synced', root: '/r', installed: { [assetId]: newDigest }, error: null, at: 2 });

  const sessionNow = { ...session, workerId: 'w1' };
  const upgraded = await environment.upgrade?.(sessionNow);
  assert.ok(upgraded);
  assert.equal(upgraded.changed, true);
  assert.deepEqual(upgraded.fromDigests, [oldDigest]);
  assert.deepEqual(upgraded.toDigests, [newDigest]);
  const afterUpgradeRevision = await environment.revision(sessionNow);
  assert.notEqual(afterUpgradeRevision, first.revision);

  const next = await environment.prepare(command);
  assert.equal(next.revision, afterUpgradeRevision);
  assert.deepEqual(next.command.kind === 'start_session' ? next.command.assetIds : null, [assetId]);
  const snapshot = await assets.deps.assets.sessionAssetSnapshot(session.id);
  assert.deepEqual(snapshot?.entries.map((entry) => entry.digest), [newDigest]);
});

test('#226：快照幂等；没有快照的会话不能升级', async () => {
  const { assets, hub, session } = await world();
  const uploaded = await uploadAsset(assets.deps, { kind: 'skill', files: skillFiles() });
  assert.ok(uploaded.ok);
  await assets.deps.assets.install('w1', uploaded.value.id, 1);
  assets.board.set('w1', {
    workerId: 'w1',
    state: 'synced',
    root: '/r',
    installed: { [uploaded.value.id]: uploaded.value.pinned },
    error: null,
    at: 1
  });
  const environment = createSessionEnvironment({ assetDeps: assets.deps, tasks: hub.deps.tasks, projects: hub.deps.projects });
  const sessionNow = { ...session, workerId: 'w1' };
  assert.equal(await environment.upgrade?.(sessionNow), null);

  const command = startCommand(sessionNow, '/tmp/env', null);
  await environment.prepare(command);
  const snapshot = await assets.deps.assets.sessionAssetSnapshot(session.id);
  assert.ok(snapshot);
  // 第二次写必须被忽略，返回 false。
  assert.equal(await assets.deps.assets.recordSessionAssetSnapshot({ ...snapshot, at: 99 }), false);
  assert.equal((await assets.deps.assets.sessionAssetSnapshot(session.id))?.at, snapshot.at);
  await environment.prepare(command);
  assert.equal((await assets.deps.assets.sessionAssetSnapshot(session.id))?.at, snapshot.at);
});
