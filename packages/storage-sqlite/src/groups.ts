import type { DatabaseSync } from 'node:sqlite';
import type { Group, GroupDelivery, GroupPost, GroupStore, GroupThread } from '@agent-hub/domain';
import { asSessionId } from '@agent-hub/domain';

type Row = Record<string, unknown>;

/**
 * 群聊（ADR 0018 · 群组）。群、对话、投递整份存 JSON（字段少、只按几个键查），
 * 查询要用的列单独拿出来建索引。
 */
export const GROUP_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_groups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  doc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_groups_project ON agent_groups(project_id, created_at);
CREATE TABLE IF NOT EXISTS agent_group_posts (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  doc TEXT NOT NULL,
  UNIQUE(group_id, seq)
);
CREATE TABLE IF NOT EXISTS agent_group_threads (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  status TEXT NOT NULL,
  doc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_group_threads_group ON agent_group_threads(group_id, created_at);
CREATE TABLE IF NOT EXISTS agent_group_deliveries (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL,
  doc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_group_deliveries_thread ON agent_group_deliveries(thread_id, created_at);
CREATE INDEX IF NOT EXISTS agent_group_deliveries_session ON agent_group_deliveries(session_id, status, created_at);
CREATE TABLE IF NOT EXISTS agent_group_sessions (
  group_id TEXT NOT NULL,
  role TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (group_id, role)
);
CREATE INDEX IF NOT EXISTS agent_group_sessions_session ON agent_group_sessions(session_id);
`;

const doc = <T>(row: Row | undefined): T | null => (row ? (JSON.parse(row.doc as string) as T) : null);
const docs = <T>(rows: unknown[]): T[] => (rows as Row[]).map((r) => JSON.parse(r.doc as string) as T);

export function createSqliteGroupStore(db: DatabaseSync): GroupStore {
  db.exec(GROUP_SCHEMA);
  const putGroup = db.prepare('INSERT INTO agent_groups (id, project_id, doc, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc');
  const getGroup = db.prepare('SELECT doc FROM agent_groups WHERE id = ?');
  const groupsOf = db.prepare('SELECT doc FROM agent_groups WHERE project_id = ? ORDER BY created_at, rowid');
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM agent_group_posts WHERE group_id = ?');
  const putPost = db.prepare('INSERT INTO agent_group_posts (id, group_id, seq, doc) VALUES (?, ?, ?, ?)');
  const latestPosts = db.prepare('SELECT doc FROM (SELECT doc, seq FROM agent_group_posts WHERE group_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq');
  const postsAfter = db.prepare('SELECT doc FROM agent_group_posts WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT ?');
  const putThread = db.prepare('INSERT INTO agent_group_threads (id, group_id, status, doc, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, doc = excluded.doc');
  const getThread = db.prepare('SELECT doc FROM agent_group_threads WHERE id = ?');
  const threads = db.prepare('SELECT doc FROM agent_group_threads WHERE group_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?');
  const running = db.prepare("SELECT doc FROM agent_group_threads WHERE group_id = ? AND status = 'running' ORDER BY created_at, rowid");
  const putDelivery = db.prepare(
    'INSERT INTO agent_group_deliveries (id, group_id, thread_id, session_id, status, doc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, status = excluded.status, doc = excluded.doc'
  );
  const deliveries = db.prepare('SELECT doc FROM agent_group_deliveries WHERE thread_id = ? ORDER BY created_at, rowid');
  const byStatus = db.prepare('SELECT doc FROM agent_group_deliveries WHERE session_id = ? AND status = ? ORDER BY created_at, rowid');
  const openBefore = db.prepare("SELECT doc FROM agent_group_deliveries WHERE status IN ('queued', 'delivered') AND created_at < ? ORDER BY created_at, rowid");
  const sessionFor = db.prepare('SELECT session_id FROM agent_group_sessions WHERE group_id = ? AND role = ?');
  const putSession = db.prepare('INSERT INTO agent_group_sessions (group_id, role, session_id) VALUES (?, ?, ?) ON CONFLICT(group_id, role) DO UPDATE SET session_id = excluded.session_id');
  const sessionsOf = db.prepare('SELECT role, session_id FROM agent_group_sessions WHERE group_id = ? ORDER BY role');
  const memberOf = db.prepare('SELECT group_id, role FROM agent_group_sessions WHERE session_id = ?');
  return {
    async saveGroup(g) {
      putGroup.run(g.id, g.projectId, JSON.stringify(g), g.createdAt);
    },
    group: async (id) => doc<Group>(getGroup.get(id) as Row | undefined),
    groupsOf: async (projectId) => docs<Group>(groupsOf.all(projectId)),
    async appendPost(p) {
      // 单连接同步执行：取最大 seq + 插入之间不会被别的写插进来
      const seq = ((maxSeq.get(p.groupId) as Row).seq as number) + 1;
      const post: GroupPost = { ...p, seq };
      putPost.run(post.id, post.groupId, seq, JSON.stringify(post));
      return post;
    },
    posts: async (groupId, afterSeq, limit) => docs<GroupPost>(afterSeq === null ? latestPosts.all(groupId, limit) : postsAfter.all(groupId, afterSeq, limit)),
    async saveThread(t) {
      putThread.run(t.id, t.groupId, t.status, JSON.stringify(t), t.createdAt);
    },
    thread: async (id) => doc<GroupThread>(getThread.get(id) as Row | undefined),
    threads: async (groupId, limit) => docs<GroupThread>(threads.all(groupId, limit)),
    runningThreads: async (groupId) => docs<GroupThread>(running.all(groupId)),
    async saveDelivery(d) {
      putDelivery.run(d.id, d.groupId, d.threadId, d.sessionId, d.status, JSON.stringify(d), d.createdAt);
    },
    deliveries: async (threadId) => docs<GroupDelivery>(deliveries.all(threadId)),
    queuedFor: async (sessionId) => docs<GroupDelivery>(byStatus.all(sessionId, 'queued')),
    deliveredTo: async (sessionId) => docs<GroupDelivery>(byStatus.all(sessionId, 'delivered')),
    openBefore: async (before) => docs<GroupDelivery>(openBefore.all(before)),
    async sessionFor(groupId, role) {
      const row = sessionFor.get(groupId, role) as Row | undefined;
      return row ? asSessionId(row.session_id as string) : null;
    },
    async setSession(groupId, role, sessionId) {
      putSession.run(groupId, role, sessionId);
    },
    sessionsOf: async (groupId) => (sessionsOf.all(groupId) as Row[]).map((r) => ({ role: r.role as string, sessionId: asSessionId(r.session_id as string) })),
    async memberOfSession(sessionId) {
      const row = memberOf.get(sessionId) as Row | undefined;
      return row ? { groupId: row.group_id as string, role: row.role as string } : null;
    }
  };
}
