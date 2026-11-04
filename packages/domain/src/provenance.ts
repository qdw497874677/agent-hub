import type { Session } from './session.ts';
import type { Permission } from './access.ts';
import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/**
 * 任务来历（ADR 0031 D3）：这条会话谁、从哪、凭什么开的。
 * 会话创建时一次写入，之后**不可变**（仓储只有 record / get，表上没有 UPDATE 路径）。
 */
export type ProvenanceVia = 'web' | 'mobile' | 'api' | 'fork' | 'rewind' | 'handoff' | 'continue_elsewhere' | 'bot' | 'group';
export type ProvenanceActorKind = 'user' | 'api_token' | 'agent' | 'system';

export interface SessionProvenance {
  readonly id: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly actor: { readonly kind: ProvenanceActorKind; readonly id: string; readonly name: string };
  readonly via: ProvenanceVia;
  /** fork / rewind / handoff / 换机继续的来源。 */
  readonly parent?: { readonly sessionId: string; readonly atSeq?: number } | null;
  readonly authority: {
    readonly role: string;
    /** 收窄后的能力范围（API 令牌的权限清单等）；不给 = 与发起者角色相同。 */
    readonly scope?: readonly string[] | null;
    readonly tokenId?: string | null;
  };
  /** 迁移时按 SessionOrigin 回填的老会话（不伪造发起人）。 */
  readonly backfilled: boolean;
  readonly createdAt: number;
}

export const PARENT_REQUIRED: ReadonlySet<ProvenanceVia> = new Set(['fork', 'rewind', 'handoff', 'continue_elsewhere']);

/**
 * 校验：
 * - authority.scope 只能收窄：每一项都必须是发起者自己持有的权限（held）。
 * - agent 发起的、或 fork/rewind/交接/换机继续，必须带 parent。
 */
export function validateProvenance(p: SessionProvenance, held: readonly Permission[] | null): Result<SessionProvenance, DomainError> {
  if (!p.sessionId || !p.taskId) return err(invalid('来历缺会话或任务'));
  if ((p.actor.kind === 'agent' || PARENT_REQUIRED.has(p.via)) && !p.parent?.sessionId) {
    return err(invalid(`来历「${p.via}」必须注明来源会话`));
  }
  if (p.authority.scope && held) {
    const wider = p.authority.scope.filter((s) => !(held as readonly string[]).includes(s));
    if (wider.length) return err(invalid(`来历的权限范围不能宽于发起者自身：${wider.join(', ')}`));
  }
  return ok(p);
}

/** 老会话回填：只按 origin 推出 via，发起人记成 system(legacy)，标「补录」。 */
export function legacyProvenance(session: Pick<Session, 'id' | 'taskId' | 'origin' | 'createdAt'>, id: string): SessionProvenance {
  const fork = session.origin.kind === 'fork' ? session.origin : null;
  return {
    id,
    sessionId: session.id,
    taskId: session.taskId,
    actor: { kind: 'system', id: 'legacy', name: '系统（补录）' },
    via: fork ? 'fork' : 'web',
    parent: fork ? { sessionId: fork.fromSessionId, atSeq: fork.atSeq } : null,
    authority: { role: 'unknown' },
    backfilled: true,
    createdAt: session.createdAt
  };
}

const VIA_LABEL: Record<ProvenanceVia, string> = {
  web: '网页',
  mobile: '手机',
  api: '开放 API',
  fork: '分叉',
  rewind: '回退',
  handoff: '交接',
  continue_elsewhere: '换机继续',
  bot: 'bot',
  group: '群聊'
};
export const viaLabel = (via: ProvenanceVia): string => VIA_LABEL[via] ?? via;
