import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAPIHono } from '@hono/zod-openapi';
import { exactTurnRoute, installExactTurn } from './exact-turn.ts';
import type { Env, V1Runtime } from './context.ts';

test('exact turn validates inputs and checks origin before reading', async () => {
  let reads = 0;
  const rt = {
    principal: () => null,
    deps: {
      sessions: { byId: async (id: string) => id === 'missing' ? null : { taskId: null, originProjectId: id === 'hidden' ? 'hidden' : 'p' } },
      projects: { byId: async (id: string) => id === 'p' ? { id, deletedAt: null } : null }
    }
  } as unknown as V1Runtime;
  const app = new OpenAPIHono<Env>();
  installExactTurn(app, rt, (sessionId, turn) => {
    reads++;
    return { sessionId, turn, promptSeq: 1, deliveryId: 'd', deliveryState:'sending', outcome:null, outcomeUnknown:false, endedSeq:null, status:'pending', reason:'delivery_sending' };
  });
  assert.equal((await app.request('/openapi/v1/sessions/missing/turns/1')).status, 404);
  assert.equal((await app.request('/openapi/v1/sessions/hidden/turns/1')).status, 404);
  assert.equal(reads, 0);
  assert.equal((await app.request('/openapi/v1/sessions/s/turns/0')).status, 400);
  assert.equal((await app.request('/openapi/v1/sessions/s/turns/9007199254740992')).status, 400);
  assert.equal((await app.request('/openapi/v1/sessions/s/turns/1?other=x')).status, 400);
  const response = await app.request('/openapi/v1/sessions/s/turns/1');
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { status: string }).status, 'pending');
  assert.equal(reads, 1);
  assert.deepEqual(exactTurnRoute.mcp, { module:'sessions', need:'session.read', readOnly:true, expose:'get_session_turn' });
});

test('project scope and session.read are enforced before storage', async () => {
  let reads = 0;
  let permissions = ['project.read'];
  const rt = {
    principal: () => ({ user: { id:'u', role:'owner', teamId:'t', clusterAdmin:false, disabledAt:null, deletedAt:null }, via: { permissions } }),
    deps: {
      sessions: { byId: async () => ({ taskId:null, originProjectId:'p' }) },
      projects: { byId: async () => ({ id:'p', teamId:'t', createdBy:'u', deletedAt:null }) },
      access: { context: async () => ({ hubTeamId:'t', settings:{ membersCanAddMachines:false } }) }
    }
  } as unknown as V1Runtime;
  const app = new OpenAPIHono<Env>();
  installExactTurn(app, rt, (sessionId, turn) => {
    reads++;
    return { sessionId, turn, promptSeq:null, deliveryId:null, deliveryState:null, outcome:null, outcomeUnknown:true, endedSeq:null, status:'unknown', reason:'insufficient_evidence' };
  });
  assert.equal((await app.request('/openapi/v1/sessions/s/turns/1')).status, 403);
  assert.equal(reads, 0);
  permissions = ['project.read','session.read'];
  assert.equal((await app.request('/openapi/v1/sessions/s/turns/1')).status, 200);
  assert.equal(reads, 1);
});
