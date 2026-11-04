import type { SessionProvenance } from '../provenance.ts';

/** 来历仓储（ADR 0031 D3）：只写一次、只读。没有 update——来历不可改。 */
export interface ProvenanceStore {
  /** 已有就不覆盖，返回 false。 */
  record(p: SessionProvenance): Promise<boolean>;
  get(sessionId: string): Promise<SessionProvenance | null>;
}
