import type { DatabaseSync } from 'node:sqlite';
import type { Group, GroupDelivery, GroupPost, GroupReaction, GroupStore, GroupThread } from '@agent-hub/domain';
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
  external_id TEXT,
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
CREATE TABLE IF NOT EXISTS agent_group_reads (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS agent_group_reactions (
  group_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, actor_kind, actor_name, emoji)
);
CREATE INDEX IF NOT EXISTS agent_group_reactions_post ON agent_group_reactions(group_id, post_id);
`;

const doc = <T>(row: Row | undefined): T | null => (row ? (JSON.parse(row.doc as string) as T) : null);
const docs = <T>(rows: unknown[]): T[] => (rows as Row[]).map((r) => JSON.parse(r.doc as string) as T);

export function createSqliteGroupStore(db: DatabaseSync): GroupStore {
  db.exec(GROUP_SCHEMA);
  // 老库补列（#219 C3）：SQLite 不能直接 ADD COLUMN 带 UNIQUE，先补列再建部分唯一索引。
  const postColumns = db.prepare('PRAGMA table_info(agent_group_posts)').all() as Row[];
  if (!postColumns.some((c) => c.name === 'external_id')) db.exec('ALTER TABLE agent_group_posts ADD COLUMN external_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS agent_group_posts_external ON agent_group_posts(group_id, external_id) WHERE external_id IS NOT NULL');
  const putGroup = db.prepare('INSERT INTO agent_groups (id, project_id, doc, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc');
  const getGroup = db.prepare('SELECT doc FROM agent_groups WHERE id = ?');
  const groupsOf = db.prepare('SELECT doc FROM agent_groups WHERE project_id = ? ORDER BY created_at, rowid');
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM agent_group_posts WHERE group_id = ?');
  const putPost = db.prepare('INSERT INTO agent_group_posts (id, group_id, seq, doc, external_id) VALUES (?, ?, ?, ?, ?)');
  const postByExternal = db.prepare('SELECT doc FROM agent_group_posts WHERE group_id = ? AND external_id = ? LIMIT 1');
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
  const putRead = db.prepare('INSERT INTO agent_group_reads (group_id, user_id, seq) VALUES (?, ?, ?) ON CONFLICT(group_id, user_id) DO UPDATE SET seq = MAX(seq, excluded.seq)');
  const unread = db.prepare(
    "SELECT COUNT(*) AS n FROM agent_group_posts WHERE group_id = ? AND seq > COALESCE((SELECT seq FROM agent_group_reads WHERE group_id = ? AND user_id = ?), 0) AND NOT (json_extract(doc, '$.author.kind') = 'user' AND json_extract(doc, '$.author.id') = ?)"
  );
  const putReaction = db.prepare(
    'INSERT INTO agent_group_reactions (group_id, post_id, actor_kind, actor_name, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(post_id, actor_kind, actor_name, emoji) DO NOTHING'
  );
  const dropReaction = db.prepare('DELETE FROM agent_group_reactions WHERE post_id = ? AND actor_kind = ? AND actor_name = ? AND emoji = ?');
  // 帖数不定：按 IN 里占位符个数缓存语句（node:sqlite 的语句可重复执行）。
  const reactionsByPosts = new Map<number, ReturnType<DatabaseSync['prepare']>>();
  const reactionsOf = (count: number): ReturnType<DatabaseSync['prepare']> => {
    let stmt = reactionsByPosts.get(count);
    if (!stmt) {
      const holes = Array.from({ length: count }, () => '?').join(', ');
      stmt = db.prepare(
        `SELECT post_id, actor_kind, actor_name, emoji, created_at FROM agent_group_reactions WHERE group_id = ? AND post_id IN (${holes}) ORDER BY created_at, rowid`
      );
      reactionsByPosts.set(count, stmt);
    }
    return stmt;
  };
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
      putPost.run(post.id, post.groupId, seq, JSON.stringify(post), post.externalId ?? null);
      return post;
    },
    postByExternalId: async (groupId, externalId) => doc<GroupPost>(postByExternal.get(groupId, externalId) as Row | undefined),
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
    },
    async markRead(groupId, userId, seq) {
      putRead.run(groupId, userId, seq);
    },
    unreadCount: async (groupId, userId) => (unread.get(groupId, groupId, userId, userId) as Row).n as number,
    latestSeq: async (groupId) => (maxSeq.get(groupId) as Row).seq as number,
    async reactions(groupId, postIds) {
      const out = new Map<string, GroupReaction[]>();
      const ids = [...new Set(postIds)];
      if (ids.length === 0) return out;
      for (const row of reactionsOf(ids.length).all(groupId, ...ids) as Row[]) {
        const postId = row.post_id as string;
        const list = out.get(postId) ?? [];
        list.push({
          emoji: row.emoji as string,
          actor: { kind: row.actor_kind as 'user' | 'agent', name: row.actor_name as string },
          createdAt: row.created_at as number
        });
        out.set(postId, list);
      }
      return out;
    },
    async addReaction(groupId, postId, actor, emoji, now) {
      putReaction.run(groupId, postId, actor.kind, actor.name, emoji, now);
    },
    async removeReaction(_groupId, postId, actor, emoji) {
      dropReaction.run(postId, actor.kind, actor.name, emoji);
    }
  };
}
