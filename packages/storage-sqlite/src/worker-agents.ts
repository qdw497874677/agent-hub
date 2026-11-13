import type { DatabaseSync } from 'node:sqlite';
import { agentAliasesProblem, normalizeAgentAliases, type AgentAlias, type WorkerAgentsRepository } from '@agent-hub/domain';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS worker_agents (
  worker_id TEXT PRIMARY KEY,
  doc TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

interface WorkerAgentsRow {
  worker_id: string;
  doc: string;
  updated_at: number;
}

/**
 * 每台 Worker 的自定义运行时别名（CAP-1）。整张表一个 worker 一行 JSON：
 * 读的是「这台机器上有哪些别名」，不需要按别名查。
 * 空数组 = 删掉这一行，回到「从没配过」。
 */
export function createSqliteWorkerAgents(db: DatabaseSync): WorkerAgentsRepository {
  db.exec(SCHEMA);
  const select = db.prepare('SELECT * FROM worker_agents WHERE worker_id = ?');
  const upsert = db.prepare(
    'INSERT INTO worker_agents(worker_id, doc, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(worker_id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at'
  );
  const remove = db.prepare('DELETE FROM worker_agents WHERE worker_id = ?');
  /** 坏 doc 只吵一次：每次读都打日志会把日志刷满。 */
  const complained = new Set<string>();

  return {
    async get(workerId) {
      const row = select.get(workerId) as unknown as WorkerAgentsRow | undefined;
      if (!row) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.doc);
      } catch {
        parsed = null;
      }
      if (agentAliasesProblem(parsed) !== null) {
        if (!complained.has(workerId)) {
          complained.add(workerId);
          console.log(`[storage] Worker ${workerId} 的运行时别名落盘内容不合法，按「没配过」处理`);
        }
        return null;
      }
      return normalizeAgentAliases(parsed as AgentAlias[]);
    },
    async save(workerId, aliases) {
      if (aliases.length === 0) {
        remove.run(workerId);
        complained.delete(workerId);
        return;
      }
      upsert.run(workerId, JSON.stringify(normalizeAgentAliases(aliases)), Date.now());
      complained.delete(workerId);
    }
  };
}
