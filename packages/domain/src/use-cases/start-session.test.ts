import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../session.ts';
import { deriveSession } from '../session.ts';
import { asAgentId } from '../ids.ts';
import { unavailable } from '../errors.ts';
import { err, ok } from '../result.ts';
import type { WorkerCommand } from '../ports/node-gateway.ts';
import { fakeGit, inMemoryDeps } from '../testing/in-memory.ts';
import type { Deps } from './deps.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { startSessionUseCase } from './start-session.ts';

/**
 * 启动入口：derive / resume / fork / rewind / continue 最后都走 startSessionUseCase。
 * 这里回答三个「顺序为什么是这样」的问题：什么时候标 failed、什么时候托管、
 * 环境版本什么时候落库（且失败不能反过来拖垮启动）。
 */

const localGateway = {
  probe: async () => true,
  status: async () => [{ workerId: 'local', label: '本机', origin: 'local' as const, state: 'online' as const }],
  dispatch: async () => ok(undefined),
  listDirectories: async (_id: string, path: string) => ok({ path, exists: true, entries: [] }),
  makeDirectory: async (_id: string, parent: string, name: string) => ok({ path: `${parent}/${name}` }),
  listFiles: async () => ok({ files: [], truncated: false }),
  readFile: async () => ok(null),
  git: () => fakeGit().on('remote')
};

/** 落库一条本机会话：任务、模型、workerId 都齐了，只差启动。 */
async function setup(overrides: Parameters<typeof inMemoryDeps>[0] = {}) {
  const w = inMemoryDeps(overrides);
  const project = await createProjectUseCase(w.deps, { name: 'start', rootPath: '/tmp/start' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '启动' });
  assert.ok(task.ok);
  const made = deriveSession({
    task: task.value,
    agentId: asAgentId('fake'),
    model: 'm1',
    now: 1,
    workerId: 'local'
  });
  assert.ok(made.ok);
  const session: Session & { readonly workerId: string } = { ...made.value, workerId: 'local' };
  await w.deps.sessions.save(session);
  return { w, session };
}

test('启动：正常派发后登记托管，指令带上工作目录与来源选项', async () => {
  const sent: WorkerCommand[] = [];
  const { w, session } = await setup({
    gateway: {
      ...localGateway,
      dispatch: async (command) => {
        sent.push(command);
        return ok(undefined);
      }
    }
  });

  const started = await startSessionUseCase(w.deps, {
    session,
    workspaceRoot: '/tmp/start',
    resume: { agentSessionRef: 'agent-1', cursor: 3 },
    inheritedOptions: { model: 'm1', thinking: 'high' }
  });

  assert.ok(started.ok);
  assert.equal(sent.length, 1);
  const command = sent[0];
  assert.ok(command);
  assert.equal(command.kind, 'start_session');
  if (command.kind !== 'start_session') return;
  assert.equal(command.workerId, 'local');
  assert.equal(command.workspaceRoot, '/tmp/start');
  assert.deepEqual(command.resume, { agentSessionRef: 'agent-1', cursor: 3 });
  assert.deepEqual(command.options, { model: 'm1', thinking: 'high' });
  assert.equal(w.deps.hosting.has(session.id), true);
});

test('启动：派发失败把会话标 failed，且不托管', async () => {
  const { w, session } = await setup({
    gateway: { ...localGateway, dispatch: async () => err(unavailable('worker 掉了')) }
  });

  const started = await startSessionUseCase(w.deps, { session, workspaceRoot: '/tmp/start', resume: null });

  assert.equal(started.ok, false);
  assert.equal((await w.deps.sessions.byId(session.id))?.status, 'failed');
  assert.equal(w.deps.hosting.has(session.id), false);
});

test('重启进程（markFailed: false）：派发失败不改写状态，留着下次重试', async () => {
  const { w, session } = await setup({
    gateway: { ...localGateway, dispatch: async () => err(unavailable('worker 掉了')) }
  });
  const before = (await w.deps.sessions.byId(session.id))!.status;

  const started = await startSessionUseCase(w.deps, {
    session,
    workspaceRoot: '/tmp/start',
    resume: { agentSessionRef: null, cursor: 0 },
    markFailed: false
  });

  assert.equal(started.ok, false);
  assert.equal((await w.deps.sessions.byId(session.id))?.status, before);
  assert.equal(w.deps.hosting.has(session.id), false);
});

test('启动：环境回执里的版本在成功后落库', async () => {
  const { w, session } = await setup({
    gateway: { ...localGateway, dispatch: async () => ok({ environmentRevision: 'rev-1' }) }
  });

  const started = await startSessionUseCase(w.deps, { session, workspaceRoot: '/tmp/start', resume: null });

  assert.ok(started.ok);
  assert.equal((await w.deps.sessions.byId(session.id))?.environmentRevision, 'rev-1');
});

test('启动：回执没有环境版本时不动已存的版本', async () => {
  const { w, session } = await setup();
  await w.deps.sessions.setEnvironmentRevision(session.id, 'rev-old', 2);

  const started = await startSessionUseCase(w.deps, { session, workspaceRoot: '/tmp/start', resume: null });

  assert.ok(started.ok);
  assert.equal((await w.deps.sessions.byId(session.id))?.environmentRevision, 'rev-old');
});

test('启动：没有 environment 端口也按原指令派发（环境准备不是硬依赖）', async () => {
  const sent: WorkerCommand[] = [];
  const { w, session } = await setup({
    gateway: {
      ...localGateway,
      dispatch: async (command) => {
        sent.push(command);
        return ok(undefined);
      }
    }
  });
  const { environment: _dropped, ...withoutEnvironment } = w.deps;

  const started = await startSessionUseCase(withoutEnvironment as Pick<Deps, 'gateway' | 'hosting' | 'now' | 'sessions'>, {
    session,
    workspaceRoot: '',
    resume: null
  });

  assert.ok(started.ok);
  assert.equal(sent.length, 1);
  const command = sent[0];
  assert.ok(command);
  assert.equal(command.kind, 'start_session');
  if (command.kind !== 'start_session') return;
  assert.equal(command.workspaceRoot, '');
  // startCommand 的语义不变：模型并进 options.model。
  assert.deepEqual(command.options, { model: 'm1' });
});
