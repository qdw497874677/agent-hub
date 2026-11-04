import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyProvenance, validateProvenance, type SessionProvenance } from './provenance.ts';
import { recordProvenance } from './use-cases/provenance.ts';
import type { ProvenanceStore } from './ports/provenance-store.ts';
import type { AuditEntry } from './account.ts';

const base: SessionProvenance = {
  id: 'p', sessionId: 's', taskId: 't', actor: { kind: 'user', id: 'u', name: 'D' }, via: 'web', parent: null,
  authority: { role: 'member' }, backfilled: false, createdAt: 1
};

test('来历校验：权限只能收窄；分叉/回退/agent 发起必须带来源', () => {
  assert.equal(validateProvenance({ ...base, authority: { role: 'member', scope: ['session.read'] } }, ['session.read', 'session.prompt']).ok, true);
  const wider = validateProvenance({ ...base, authority: { role: 'member', scope: ['user.role'] } }, ['session.read']);
  assert.equal(wider.ok, false);
  assert.equal(validateProvenance({ ...base, via: 'rewind' }, null).ok, false);
  assert.equal(validateProvenance({ ...base, actor: { kind: 'agent', id: 'a', name: 'a' } }, null).ok, false);
  assert.equal(validateProvenance({ ...base, via: 'fork', parent: { sessionId: 'x' } }, null).ok, true);
});

test('老会话补录：不伪造发起人', () => {
  const l = legacyProvenance({ id: 's' as never, taskId: 't' as never, origin: { kind: 'fork', fromSessionId: 'a' as never, atSeq: 3 as never }, createdAt: 5 }, 'id');
  assert.equal(l.actor.kind, 'system');
  assert.equal(l.backfilled, true);
  assert.deepEqual(l.parent, { sessionId: 'a', atSeq: 3 });
});

test('recordProvenance：写一次 + session.created 审计带来历 id；第二次不覆盖也不重复审计', async () => {
  const rows = new Map<string, SessionProvenance>();
  const store: ProvenanceStore = {
    async record(p) { if (rows.has(p.sessionId)) return false; rows.set(p.sessionId, p); return true; },
    async get(id) { return rows.get(id) ?? null; }
  };
  const audit: AuditEntry[] = [];
  const auditLog = { append: async (e: AuditEntry) => void audit.push(e), recent: async () => [], query: async () => [] };
  const subject = { user: { id: 'u1', email: 'd@x', displayName: 'David', role: 'owner', teamId: 'T' }, loginId: 'l' } as never;
  const session = { id: 's1' as never, taskId: 't1' as never, origin: { kind: 'derive' as const } };
  const r = await recordProvenance({ provenance: store, audit: auditLog, now: () => 7 }, { session, subject, via: 'web' });
  assert.ok(r.ok);
  assert.equal(r.value.actor.name, 'David');
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.action, 'session.created');
  assert.ok(audit[0]!.detail.includes(r.value.id));
  const again = await recordProvenance({ provenance: store, audit: auditLog, now: () => 8 }, { session, subject, via: 'api' });
  assert.ok(again.ok);
  assert.equal(again.value.via, 'web');
  assert.equal(audit.length, 1);
});
