import type { DatabaseSync } from 'node:sqlite';
import { UNKNOWN_OUTCOME_MARKER, type PromptActor } from '@agent-hub/domain';

/**
 * Agent 运行记录（只读）：一条 prompt 送达 = 一条可观察记录。
 *
 * 项目归属只认会话的不可变来源，和 `projectOfSessionOrigin` / 交接受理时的
 * `canonicalProjectOf` 保持一致：有任务看任务项目，缺任务行 / 与出生项目冲突都失败关闭；
 * 无任务会话只认 `origin_project_id`，不回落到工作空间或分组这类可后改的关联。
 * 这里只做范围绑定，真正的会话级授权仍由 Hub 在详情里独立做。
 */
export interface AgentObserveDelivery {
  readonly id: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly seq: number;
  readonly state: string;
  readonly attempt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgentObserveEnded {
  readonly seq: number;
  readonly at: number;
  readonly outcome: 'done' | 'stopped' | 'interrupted' | 'failed';
  readonly unknownOutcome: boolean;
}

/** 列表最多取 501 条：调用方拿 501 判断「还有更多」，不让一次查询放大到全表。 */
export const AGENT_OBSERVE_LIMIT_MAX = 501;

const ENDED_OUTCOMES = new Set<AgentObserveEnded['outcome']>(['done', 'stopped', 'interrupted', 'failed']);

/** 只认 `DeliveryState` 落库的六种值；未知 / 历史脏值不往 Hub 送，避免读侧 unchecked cast。 */
const DELIVERY_STATES = "'queued','sending','delivered','undelivered','cancelled','held'";

const PROJECT_BINDING = 'CASE WHEN s.task_id IS NOT NULL THEN t.project_id ELSE s.origin_project_id END';

// 绑定有效 + 项目未删：项目范围过滤必须发生在 LIMIT 之前，否则不可见项目会先占满页面。
const VALID_BINDING = `(
  (s.task_id IS NOT NULL AND t.id IS NOT NULL
    AND (s.origin_project_id IS NULL OR s.origin_project_id = t.project_id))
  OR (s.task_id IS NULL AND s.origin_project_id IS NOT NULL)
)`;

const SELECT_DELIVERY = `SELECT d.id, d.session_id, d.seq, d.state, d.attempt, d.created_at, d.updated_at,
    ${PROJECT_BINDING} AS project_id
  FROM message_delivery d
  JOIN sessions s ON s.id = d.session_id
  LEFT JOIN tasks t ON t.id = s.task_id
  JOIN projects p ON p.id = ${PROJECT_BINDING}
  WHERE d.kind = 'prompt'
    AND d.state IN (${DELIVERY_STATES})
    AND p.deleted_at IS NULL
    AND ${VALID_BINDING}`;

// 旧 journal 可能有坏 JSON：所有 json_extract 都放进 CASE 的 THEN 里，
// 不靠 WHERE 的 AND 求值顺序保证安全。
const jsonField = (path: string): string => `CASE WHEN json_valid(payload) THEN json_extract(payload, '${path}') END`;
const deliveryIdField = jsonField('$.deliveryId');
const endedIndexPredicate = `type = 'ended' AND CASE WHEN json_valid(payload) THEN json_type(payload, '$.deliveryId') END = 'text'`;
const firstOutputField = jsonField('$.firstOutputDeliveryId');
const firstOutputIndexPredicate = `type = 'text' AND CASE WHEN json_valid(payload) THEN json_type(payload, '$.firstOutputDeliveryId') END = 'text'`;

// 与表达式索引保持同一表达式和部分索引谓词，允许按精确 deliveryId + seq 定位。
export const AGENT_OBSERVE_ENDED_SQL = `SELECT seq, at,
    ${jsonField('$.outcome')} AS outcome,
    CASE WHEN json_valid(payload) THEN
      CASE WHEN json_extract(payload, '$.outcome') = 'interrupted'
            AND json_type(payload, '$.reason') = 'text'
            AND instr(json_extract(payload, '$.reason'), ?) > 0
           THEN 1 ELSE 0 END
    ELSE 0 END AS unknown_outcome
  FROM journal
  WHERE ${endedIndexPredicate} AND session_id = ? AND seq > ?
    AND ${jsonField('$.kind')} = 'ended'
    AND ${deliveryIdField} = ?
  ORDER BY seq ASC LIMIT 1`;

export const AGENT_OBSERVE_FIRST_OUTPUT_SQL = `SELECT seq, at FROM journal
  WHERE ${firstOutputIndexPredicate} AND session_id = ? AND ${firstOutputField} = ?
     AND seq > ? AND seq < ?
     AND seq < COALESCE((SELECT seq FROM journal
       WHERE ${endedIndexPredicate} AND session_id = ? AND ${deliveryIdField} = ? AND seq > ?
         AND ${jsonField('$.kind')} = 'ended' ORDER BY seq ASC LIMIT 1), ${Number.MAX_SAFE_INTEGER})
     AND CASE WHEN json_valid(payload) THEN
      json_extract(payload, '$.kind') = 'text' AND json_type(payload, '$.delta') = 'text'
      AND json_extract(payload, '$.delta') <> '' AND json_type(payload, '$.subagentId') IS NULL END
  ORDER BY seq ASC LIMIT 1`;

type DeliveryRow = {
  id: string;
  session_id: string;
  seq: number;
  state: string;
  attempt: number;
  created_at: number;
  updated_at: number;
  project_id: string;
};

type EndedRow = { seq: number; at: number; outcome: string; unknown_outcome: number };

const toDelivery = (row: DeliveryRow): AgentObserveDelivery => ({
  id: row.id,
  sessionId: row.session_id,
  projectId: row.project_id,
  seq: row.seq,
  state: row.state,
  attempt: row.attempt,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

/**
 * 只读的 Agent 运行记录查询。第一条只取安全元数据，绝不把 payload / last_error
 * 或 journal 里的原始正文带出去。
 */
export function createSqliteAgentObserve(db: DatabaseSync) {
  // 聚焦的索引：按创建时间倒序扫 prompt 送达，避免列表查询退化成全表扫描 + 临时排序。
  // 表由 deliveries 模块创建；组合根先建它。这里只在表存在时补索引，重复调用无副作用。
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_delivery'").get()) {
    db.exec(`CREATE INDEX IF NOT EXISTS message_delivery_observe_prompt
      ON message_delivery(kind, created_at DESC, id DESC)`);
  }
  // 索引只在 reader 初始化时建立；坏 JSON 和非字符串 deliveryId 不进入索引。
  db.exec(`CREATE INDEX IF NOT EXISTS journal_observe_ended_delivery
    ON journal(session_id, ${deliveryIdField}, seq) WHERE ${endedIndexPredicate}`);
  db.exec(`CREATE INDEX IF NOT EXISTS journal_observe_first_output
    ON journal(session_id, ${firstOutputField}, seq) WHERE ${firstOutputIndexPredicate}`);

  const list = db.prepare(`${SELECT_DELIVERY}
    AND d.created_at >= ?
    AND p.id IN (SELECT value FROM json_each(?))
    ORDER BY d.created_at DESC, d.id DESC
    LIMIT ?`);
  const byId = db.prepare(`${SELECT_DELIVERY} AND d.id = ?`);
  // 只认同一条会话里、来源 seq 之后、deliveryId 精确相等的最早 ended；
  // 不从 prompt 的 seq 窗口或会话状态反推「这一轮结束了没有」。
  // outcome 与结果未知标记都在 SQL 里按固定规则算，不把 payload / reason 原文取出来。
  const ended = db.prepare(AGENT_OBSERVE_ENDED_SQL);
  const firstOutput = db.prepare(AGENT_OBSERVE_FIRST_OUTPUT_SQL);
  // 只取精确会话 + seq 的 prompt，且只让固定类别离开 SQLite。
  const promptActor = db.prepare(`SELECT CASE WHEN json_valid(payload) THEN
      CASE WHEN json_extract(payload, '$.kind') = 'prompt'
        AND json_type(payload, '$.promptActor') = 'text'
        AND json_extract(payload, '$.promptActor') IN ('account', 'token', 'system', 'unknown')
        THEN json_extract(payload, '$.promptActor') END
      END AS actor
    FROM journal WHERE session_id = ? AND seq = ? AND type = 'prompt'`);

  return {
    list(input: { projectIds: readonly string[]; since: number; limit: number }): readonly AgentObserveDelivery[] {
      if (!Array.isArray(input.projectIds) || input.projectIds.length === 0) return [];
      const since = Number.isFinite(input.since) ? Math.trunc(input.since) : 0;
      const requested = Number.isFinite(input.limit) ? Math.trunc(input.limit) : AGENT_OBSERVE_LIMIT_MAX;
      const limit = Math.max(1, Math.min(AGENT_OBSERVE_LIMIT_MAX, requested));
      return (list.all(since, JSON.stringify(input.projectIds), limit) as DeliveryRow[]).map(toDelivery);
    },

    byId(id: string): AgentObserveDelivery | null {
      const row = byId.get(id) as DeliveryRow | undefined;
      return row ? toDelivery(row) : null;
    },

    promptActor(sessionId: string, seq: number): PromptActor | null {
      if (!Number.isSafeInteger(seq) || seq <= 0) return null;
      const row = promptActor.get(sessionId, seq) as { actor: PromptActor | null } | undefined;
      return row?.actor ?? null;
    },

    firstOutput(sessionId: string, deliveryId: string, afterSeq: number, beforeSeq: number | null): { seq: number; at: number } | null {
      if (!Number.isSafeInteger(afterSeq) || afterSeq <= 0) return null;
      if (beforeSeq !== null && (!Number.isSafeInteger(beforeSeq) || beforeSeq <= afterSeq)) return null;
      // 即使精确结束记录损坏而不能展示结果，它的 seq 仍截住输出查询。
      const row = firstOutput.get(sessionId, deliveryId, afterSeq, beforeSeq ?? Number.MAX_SAFE_INTEGER,
        sessionId, deliveryId, afterSeq) as { seq: number; at: number } | undefined;
      return row ? { seq: row.seq, at: row.at } : null;
    },

    ended(sessionId: string, deliveryId: string, afterSeq: number): AgentObserveEnded | null {
      if (!Number.isSafeInteger(afterSeq) || afterSeq <= 0) return null;
      const row = ended.get(UNKNOWN_OUTCOME_MARKER, sessionId, afterSeq, deliveryId) as EndedRow | undefined;
      if (!row) return null;
      const outcome = row.outcome;
      if (typeof outcome !== 'string' || !ENDED_OUTCOMES.has(outcome as AgentObserveEnded['outcome'])) return null;
      return {
        seq: row.seq,
        at: row.at,
        outcome: outcome as AgentObserveEnded['outcome'],
        unknownOutcome: Number(row.unknown_outcome) === 1
      };
    }
  };
}
