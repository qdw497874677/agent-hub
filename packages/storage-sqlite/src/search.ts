import type { DatabaseSync } from 'node:sqlite';
import type { SearchGateway, SearchHit } from '@agent-hub/domain';
import { asSessionId, asTaskId } from '@agent-hub/domain';

/**
 * 读侧搜索。两个来源：任务自己的标题/目标，以及会话里模型说过的整句话。
 *
 * 这里用 LIKE 而不是 FTS5：v1 的数据量（一年 10⁶ 行以内）下 LIKE 够快，
 * 而 FTS5 要维护影子表、要写触发器、还要处理中文分词——那是 T2 的账。
 * 需要时换成 FTS5 只动这个文件，端口没变。
 */
export function createSearch(db: DatabaseSync): SearchGateway {
  const tasks = db.prepare(
    "SELECT id, title, IFNULL(goal, '') AS goal FROM tasks " +
      "WHERE project_id = ? AND (title LIKE ? ESCAPE '\\' OR IFNULL(goal, '') LIKE ? ESCAPE '\\') " +
      'ORDER BY updated_at DESC LIMIT ?'
  );
  // 查投影而不是 journal：流式回复把一句话拆成几十行 delta，按行匹配跨行的词必失。
  const sessionText = db.prepare(
    'SELECT s.id AS session_id, s.task_id, t.title, st.text FROM session_text st ' +
      'JOIN sessions s ON s.id = st.session_id ' +
      'JOIN tasks t ON t.id = s.task_id ' +
      "WHERE t.project_id = ? AND st.text LIKE ? ESCAPE '\\' " +
      'ORDER BY st.updated_at DESC LIMIT ?'
  );

  return {
    async search(query): Promise<readonly SearchHit[]> {
      // 空词返回空，而不是 LIKE '%%' 把全库倒出来。业务上「词不能为空」由用例层拒绝，
      // 这里是防呆：任何调用方漏了校验，也不该变成一次全表泄漏。
      if (query.query.trim() === '') return [];
      const pattern = `%${escapeLike(query.query)}%`;
      const limit = Math.max(1, Math.min(50, query.limit));

      const hits: SearchHit[] = [];
      const sessionRows = sessionText.all(query.projectId, pattern, limit) as {
        session_id: string;
        task_id: string;
        title: string;
        text: string;
      }[];
      const seen = new Set<string>();
      for (const row of sessionRows) {
        // 同一个会话里命中多次，只留最新的一条——列表里重复十遍没有信息量。
        if (seen.has(row.session_id)) continue;
        seen.add(row.session_id);
        hits.push({
          kind: 'session',
          taskId: asTaskId(row.task_id),
          sessionId: asSessionId(row.session_id),
          title: row.title,
          snippet: excerpt(row.text, query.query)
        });
      }

      const taskRows = tasks.all(query.projectId, pattern, pattern, limit) as {
        id: string;
        title: string;
        goal: string;
      }[];
      for (const row of taskRows) {
        hits.push({
          kind: 'task',
          taskId: asTaskId(row.id),
          sessionId: null,
          title: row.title,
          snippet: row.goal === '' ? '' : excerpt(row.goal, query.query)
        });
      }

      return hits.slice(0, limit);
    }
  };
}

/** LIKE 里的 `%`、`_`、`\` 必须转义，不然用户搜 "100%" 会match 到一切。 */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** 命中点前后各取一段，让人知道为什么这条被搜出来。 */
function excerpt(text: string, query: string, span = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, span * 2);
  const start = Math.max(0, at - span);
  const end = Math.min(flat.length, at + query.length + span);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}
