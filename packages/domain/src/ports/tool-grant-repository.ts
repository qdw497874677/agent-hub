import type { SessionId } from '../ids.ts';
import type { ToolCallRecord, ToolGrant } from '../tool.ts';

/** 工具授权与调用审计。令牌只以 hash 形式出现。 */
export interface ToolGrantRepository {
  save(grant: ToolGrant): Promise<void>;
  byTokenHash(hash: string): Promise<ToolGrant | null>;
  /** 作废这条会话所有还有效的授权；返回作废了几条。 */
  revokeSession(sessionId: SessionId, now: number): Promise<number>;
  /** 作废所有还有效、且会话不在 `keep` 里的授权；返回作废了几条。`keep` 为空 = 全部作废。 */
  revokeAllExcept(keep: readonly SessionId[], now: number): Promise<number>;
  recordCall(record: ToolCallRecord): Promise<void>;
  /** 新的在前。 */
  recentCalls(limit: number, sessionId?: SessionId): Promise<ToolCallRecord[]>;
}
