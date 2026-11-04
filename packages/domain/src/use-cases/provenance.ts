import { principalOfSubject, isSystem, rolePermissions, type Permission, type Subject } from '../access.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { ProvenanceStore } from '../ports/provenance-store.ts';
import { validateProvenance, type SessionProvenance, type ProvenanceVia } from '../provenance.ts';
import type { Session } from '../session.ts';
import { newId } from '../ids.ts';
import { err, ok, type Result } from '../result.ts';
import type { DomainError } from '../errors.ts';

export interface ProvenanceDeps {
  readonly provenance: ProvenanceStore;
  readonly audit?: AuditLog;
  readonly now: () => number;
}

export interface RecordProvenanceInput {
  readonly session: Pick<Session, 'id' | 'taskId' | 'origin'>;
  readonly subject: Subject | null;
  readonly via: ProvenanceVia;
  /** 不给就按 session.origin 推（fork 时）。 */
  readonly parent?: { readonly sessionId: string; readonly atSeq?: number } | null;
  /** 显式收窄的范围（例如给 agent 的能力预设）。令牌请求自动取令牌权限。 */
  readonly scope?: readonly string[] | null;
  readonly ip?: string | null;
  readonly teamId?: string | null;
}

/** 会话建好后一次写入来历，并记一条 session.created 审计（detail 带来历 id）。 */
export async function recordProvenance(deps: ProvenanceDeps, input: RecordProvenanceInput): Promise<Result<SessionProvenance, DomainError>> {
  const principal = principalOfSubject(input.subject);
  const via = principal?.via;
  const held: Permission[] | null = principal ? (Object.keys(rolePermissions(principal)) as Permission[]) : null;
  const origin = input.session.origin;
  const parent = input.parent ?? (origin.kind === 'fork' ? { sessionId: origin.fromSessionId, atSeq: origin.atSeq } : null);
  const actor: SessionProvenance['actor'] = principal
    ? via
      ? { kind: 'api_token', id: via.tokenId, name: `${principal.user.displayName ?? principal.user.email} · 令牌「${via.name}」` }
      : { kind: 'user', id: principal.user.id, name: principal.user.displayName ?? principal.user.email }
    : { kind: 'system', id: isSystem(input.subject) ? input.subject.reason : 'system', name: '系统' };
  const scope = input.scope ?? (via ? [...via.permissions] : null);
  const p: SessionProvenance = {
    id: newId(),
    sessionId: input.session.id,
    taskId: input.session.taskId,
    actor,
    via: via && input.via === 'web' ? 'api' : input.via,
    parent,
    authority: { role: principal?.user.role ?? 'system', ...(scope ? { scope } : {}), ...(via ? { tokenId: via.tokenId } : {}) },
    backfilled: false,
    createdAt: deps.now()
  };
  const valid = validateProvenance(p, held);
  if (!valid.ok) return err(valid.error);
  const fresh = await deps.provenance.record(p);
  if (!fresh) return ok((await deps.provenance.get(p.sessionId)) ?? p);
  if (deps.audit && principal) {
    await deps.audit
      .append({
        id: newId(),
        actorId: principal.user.id,
        actorEmail: principal.user.email,
        action: 'session.created',
        target: p.sessionId,
        detail: `来历 ${p.id} · ${p.via}${p.parent ? ` · 来自 ${p.parent.sessionId}` : ''}${via ? ` · via 令牌「${via.name}」` : ''}`,
        at: p.createdAt,
        ip: input.ip ?? null,
        teamId: input.teamId ?? principal.user.teamId ?? null
      })
      .catch(() => undefined);
  }
  return ok(p);
}
