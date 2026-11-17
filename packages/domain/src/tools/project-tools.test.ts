import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from '../result.ts';
import type { Project } from '../project.ts';
import type { Session } from '../session.ts';
import type { ToolGrant } from '../tool.ts';
import { createProjectToolProvider } from './project-tools.ts';

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'app',
  repo: null,
  repos: [],
  description: null,
  checks: [],
  createdAt: 1,
  teamId: 't',
  createdBy: 'u1',
  members: [],
  worktree: null,
  deletedAt: null,
  ...over
} as Project);

const session = (over: Partial<Session> = {}): Session => ({
  id: 's1',
  taskId: 't1' as never,
  workspaceId: 'w1' as never,
  groupId: null,
  botId: null,
  workerId: 'w1',
  agentId: 'opencode',
  model: 'm',
  options: {},
  createdBy: 'u1',
  status: 'running',
  ...over
} as unknown as Session);

const grant: ToolGrant = {
  id: 'g1',
  tokenHash: 'h',
  taskId: 't1' as never,
  sessionId: 's1' as never,
  workerId: 'w1',
  scopes: ['project'],
  createdAt: 1,
  expiresAt: 2,
  revokedAt: null
};

function world(current = project(), opts: { root?: string; actor?: string; policy?: boolean } = {}) {
  const ran: Array<{ command: string; path: string }> = [];
  const updates: Array<Record<string, unknown>> = [];
  const provider = createProjectToolProvider({
    sessions: { byId: async () => session() } as never,
    tasks: { byId: async () => ({ id: 't1', projectId: 'p1' }) as never } as never,
    projects: { byId: async () => current as never } as never,
    workspaceGroups: { byId: async () => null } as never,
    bots: { byId: async () => null } as never,
    workspaces: { byId: async () => ({ id: 'w1', projectId: 'p1', path: opts.root ?? '/w', state: 'ready', workerId: 'w1' }) as never } as never,
    gateway: {
      git: () => ({
        runSetup: async (input: { command: string; path: string }) => {
          ran.push({ command: input.command, path: input.path });
          return ok({ exitCode: input.command.includes('fail') ? 1 : 0, output: 'out', timedOut: false });
        }
      })
    } as never,
    access: opts.policy
      ? {
          context: async () => ({ hubTeamId: 't', settings: { openRegistration: false, membersCanAddMachines: true, refuseWhenFull: [] } }),
          worker: async () => ({ kind: 'worker', id: 'w1', teamId: 't', createdBy: null, local: true })
        } as never
      : undefined,
    subjectOf: async () =>
      opts.actor
        ? ({ loginId: 'l1', user: { id: opts.actor, name: opts.actor, teamId: 't', role: 'member', createdAt: 1, disabledAt: null, deletedAt: null } } as never)
        : null,
    update: async (input) => {
      updates.push(input as never);
      return ok(project({ checks: (input.checks as string[]) ?? [], description: (input.description as string) ?? null }));
    }
  });
  return { provider, ran, updates };
}

test('run.checks：项目没声明检查命令就不猜', async () => {
  const { provider, ran } = world();
  const result = await provider.call('run.checks', {}, { grant } as never);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, {
    ran: false,
    project_id: 'p1',
    checks: [],
    reason: '这个项目还没有声明检查命令：请项目所有者先在项目设置里加上（最多 5 条）'
  });
  assert.deepEqual(ran, []);
});

test('run.checks：按顺序跑，遇到非 0 就停', async () => {
  const { provider, ran } = world(project({ checks: ['npm run typecheck', 'npm test', 'npm run build'] }));
  const result = await provider.call('run.checks', {}, { grant } as never);
  assert.equal(result.ok, true);
  const value = result.ok ? (result.value as { checks: Array<{ command: string; exit_code: number }>; passed: boolean }) : null;
  assert.deepEqual(value?.checks.map((c) => [c.command, c.exit_code]), [
    ['npm run typecheck', 0],
    ['npm test', 0],
    ['npm run build', 0]
  ]);
  assert.equal(value?.passed, true);
  assert.deepEqual(ran.map((r) => r.path), ['/w', '/w', '/w']);

  const failing = world(project({ checks: ['npm run typecheck', 'npm run fail'] }));
  const stopped = await failing.provider.call('run.checks', {}, { grant } as never);
  const stoppedValue = stopped.ok ? (stopped.value as { checks: unknown[]; passed: boolean }) : null;
  assert.equal(stoppedValue?.checks.length, 2);
  assert.equal(stoppedValue?.passed, false);
  assert.equal(failing.ran.length, 2);
});

test('project.update：只改传进来的字段，返回更新后的项目摘要', async () => {
  const { provider, updates } = world();
  const result = await provider.call('project.update', { description: '部署：npm run up', checks: ['npm test'] }, { grant } as never);
  assert.equal(result.ok, true);
  assert.deepEqual(updates[0], { projectId: 'p1', description: '部署：npm run up', checks: ['npm test'] });
  assert.deepEqual(result.ok ? result.value : null, { id: 'p1', name: 'app', description: '部署：npm run up', checks: ['npm test'] });
});

test('project.update：什么都不传要明说', async () => {
  const { provider, updates } = world();
  const result = await provider.call('project.update', {}, { grant } as never);
  assert.equal(result.ok, false);
  assert.deepEqual(updates, []);
});

test('run.checks：被共享的成员可以跑（#227）', async () => {
  const { provider, ran } = world(project({ checks: ['true'], createdBy: 'u1', members: ['u2'] }), { actor: 'u2', policy: true });
  const allowed = await provider.call('run.checks', {}, { grant } as never);
  assert.equal(allowed.ok, true, allowed.ok ? '' : allowed.error.message);
  assert.equal(ran.length, 1);
});

test('run.checks：不是创建者也没被共享时跑不了（#227）', async () => {
  const { provider, ran } = world(project({ checks: ['true'], createdBy: 'u1' }), { actor: 'u2', policy: true });
  const denied = await provider.call('run.checks', {}, { grant } as never);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.error.message, /跑不了这个项目的检查命令/);
  assert.deepEqual(ran, []);
});

test('run.checks：项目所有者可以跑（#227）', async () => {
  const { provider, ran } = world(project({ checks: ['true'], createdBy: 'u1' }), { actor: 'u1', policy: true });
  const allowed = await provider.call('run.checks', {}, { grant } as never);
  assert.equal(allowed.ok, true, allowed.ok ? '' : allowed.error.message);
  assert.equal(ran.length, 1);
});
