import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { AgentAlias, AuditEntry, Principal, Role, WorkerAgentsRepository } from '@agent-hub/domain';
import { installWorkerAgentRoutes, type WorkerAgentsApi } from './worker-agents-routes.ts';

const valid = { id: 'claude-code', label: 'Claude Code', command: 'claude-code-acp', args: ['--acp'] };

function harness(initial: readonly AgentAlias[] | null = null) {
  const rows = new Map<string, readonly AgentAlias[]>();
  if (initial) rows.set('w1', initial);
  const saved: { workerId: string; aliases: readonly AgentAlias[] }[] = [];
  const sent: { workerId: string; aliases: readonly AgentAlias[] }[] = [];
  const audit: AuditEntry[] = [];
  const repo: WorkerAgentsRepository = {
    async get(workerId) {
      return rows.get(workerId) ?? null;
    },
    async save(workerId, aliases) {
      if (aliases.length === 0) rows.delete(workerId);
      else rows.set(workerId, aliases);
      saved.push({ workerId, aliases });
    }
  };
  const api: WorkerAgentsApi = {
    repo,
    send: (workerId, aliases) => {
      sent.push({ workerId, aliases });
      return true;
    },
    audit: {
      async append(entry) {
        audit.push(entry);
      }
    },
    now: () => 123
  };
  let role: Role | null = 'owner';
  const app = new Hono();
  installWorkerAgentRoutes(app, api, () => (role === null ? null : ({ user: { id: 'u1', email: 'u@example.com', role }, loginId: 'u1' } as unknown as Principal)));
  const call = (method: string, body?: unknown) =>
    app.request('/api/workers/w1/agents', {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {})
    });
  return { call, saved, sent, audit, setRole: (next: Role | null) => { role = next; } };
}

test('GET：没登录 401；member 403；owner / admin 可读，没配过回空数组', async () => {
  const world = harness();
  world.setRole(null);
  assert.equal((await world.call('GET')).status, 401);
  world.setRole('member');
  assert.equal((await world.call('GET')).status, 403);
  world.setRole('admin');
  const asAdmin = await world.call('GET');
  assert.equal(asAdmin.status, 200);
  assert.deepEqual(await asAdmin.json(), { aliases: [] });
  world.setRole('owner');
  assert.equal((await world.call('GET')).status, 200);
});

test('GET：配过就返回别名表', async () => {
  const world = harness([valid]);
  const response = await world.call('GET');
  assert.deepEqual(await response.json(), { aliases: [valid] });
});

test('PUT：只有 owner 能改（admin 也 403）', async () => {
  const world = harness();
  world.setRole('admin');
  assert.equal((await world.call('PUT', { aliases: [valid] })).status, 403);
  world.setRole('member');
  assert.equal((await world.call('PUT', { aliases: [valid] })).status, 403);
  world.setRole('owner');
  assert.equal((await world.call('PUT', { aliases: [valid] })).status, 200);
});

test('PUT：不合法的别名 400，文案指出哪项不对，且不存不推', async () => {
  const world = harness();
  const response = await world.call('PUT', { aliases: [{ ...valid, command: '' }] });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'invalid');
  assert.match(body.error.message, /command 不能为空/);
  assert.equal(world.saved.length, 0);
  assert.equal(world.sent.length, 0);

  const notObject = await world.call('PUT', { aliases: [valid, 1] });
  assert.equal(notObject.status, 400);
});

test('PUT：成功存库 + 推给 worker + 审计 worker.agents', async () => {
  const world = harness();
  const response = await world.call('PUT', { aliases: [valid, { id: 'second', label: '第二个', command: 'agent-b', args: [] }] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { aliases: [valid, { id: 'second', label: '第二个', command: 'agent-b', args: [] }] });
  assert.deepEqual(world.saved, [{ workerId: 'w1', aliases: [valid, { id: 'second', label: '第二个', command: 'agent-b', args: [] }] }]);
  assert.deepEqual(world.sent, world.saved);
  assert.equal(world.audit.length, 1);
  assert.equal(world.audit[0]?.action, 'worker.agents');
  assert.equal(world.audit[0]?.target, 'w1');
  assert.equal(world.audit[0]?.detail, '2 个别名');
  assert.equal(world.audit[0]?.at, 123);
});

test('PUT：空数组 = 清空（也推给 worker，让它回到 ACP_AGENTS）', async () => {
  const world = harness([valid]);
  const response = await world.call('PUT', { aliases: [] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { aliases: [] });
  assert.deepEqual(world.sent, [{ workerId: 'w1', aliases: [] }]);
  assert.equal(world.audit[0]?.detail, '0 个别名');
});
