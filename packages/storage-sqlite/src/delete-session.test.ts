import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from '@agent-hub/domain';
import { createTask } from '@agent-hub/domain';
import { deriveSession } from '@agent-hub/domain';
import { asAgentId, type ArtifactId } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';
import { createSqliteSessionBases } from './session-bases.ts';
import { createAssetRepository } from './assets.ts';
import { createSqliteCheckpoints, createSqliteTurnRefs } from './turn-checkpoints.ts';
import { createToolGrantRepository } from './tool-grants.ts';
import { createSqliteDeliveries } from './deliveries.ts';
import { createSqliteAttention } from './attention.ts';
import { createSqliteGroupStore } from './groups.ts';
import { createSqliteMessageStore } from './messages.ts';
import { createSqliteConnectors } from './connectors.ts';
import { createSqliteProvenance } from './provenance.ts';
import { createSqliteAccess } from './access.ts';

const count = (db: any, table: string, where = '1 = 1', ...params: any[]): number =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(...params) as { c: number }).c;

test('彻底删除会话：所有按 session_id 关联的行清掉，可空的历史引用置 NULL，另一端和 Task 保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-delete-session-'));
  try {
    const store = openSqliteStore(join(dir, 'hub.db'));
    const db = store.db;
    // 这些模块的表由组合根在 openSqliteStore 之后单独建；测试里显式建出来。
    void createSqliteSessionBases(db);
    void createAssetRepository(db);
    void createSqliteCheckpoints(db);
    void createSqliteTurnRefs(db);
    void createToolGrantRepository(db);
    void createSqliteDeliveries(db);
    void createSqliteAttention(db);
    void createSqliteGroupStore(db);
    void createSqliteMessageStore(db);
    void createSqliteConnectors(db);
    void createSqliteProvenance(db);
    void createSqliteAccess(db);
    const project = createProject({ name: 'demo', now: 1, teamId: 't1', createdBy: 'u1' });
    assert.ok(project.ok);
    const task = createTask({ projectId: project.value.id, title: 't', goal: '', now: 1 });
    assert.ok(task.ok);
    const s1 = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1, createdBy: 'u1' });
    assert.ok(s1.ok);
    const s2 = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1, createdBy: 'u1' });
    assert.ok(s2.ok);
    await store.projects.save(project.value);
    await store.tasks.save(task.value);
    await store.sessions.save(s1.value);
    await store.sessions.save(s2.value);
    await store.sessions.append({ ...s1.value, lastSeq: 1 }, { kind: 'text', delta: 'hello' }, 2);
    await store.sessions.linkEntry(s1.value.id, 1, 'agent-entry-1');
    await store.artifacts.save({ id: 'a1' as ArtifactId, sessionId: s1.value.id, taskId: task.value.id, path: 'out.txt', bytes: 3, label: 'out', createdAt: 3 });

    const run = (sql: string, ...params: any[]) => db.prepare(sql).run(...params);
    // PR 模块的表由组合根单独建：先建出来，验证 remove 的运行时探测。
    db.exec('CREATE TABLE task_pull_requests (id TEXT PRIMARY KEY, session_id TEXT)');

    run('INSERT INTO session_links (project_id, a_session_id, b_session_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)', project.value.id, s1.value.id, s2.value.id, 'u1', 1);
    run('INSERT INTO session_links (project_id, a_session_id, b_session_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)', project.value.id, s2.value.id, 's3', 'u1', 1);
    run('INSERT INTO session_git_bases (session_id, head) VALUES (?, ?)', s1.value.id, 'sha1');
    run('INSERT INTO session_assets (session_id, manifest) VALUES (?, ?)', s1.value.id, '{}');
    run('INSERT INTO turn_checkpoints (session_id, turn, prompt_seq, before_sha, started_at) VALUES (?, ?, ?, ?, ?)', s1.value.id, 1, 1, 'sha0', 1);
    run('INSERT INTO turn_refs (session_id, prompt_seq, turn_ref) VALUES (?, ?, ?)', s1.value.id, 1, 'refs/agents/x');
    run('INSERT INTO tool_grants (id, token_hash, task_id, session_id, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'g1', 'h1', task.value.id, s1.value.id, '[]', 1, 9);
    run('INSERT INTO tool_calls (id, grant_id, task_id, session_id, tool, version, ok, detail, latency_ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'c1', 'g1', task.value.id, s1.value.id, 'read', 1, 1, '', 1, 1);
    run('INSERT INTO message_delivery (id, session_id, seq, kind, payload, state, attempt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'd1', s1.value.id, 1, 'prompt', '{}', 'pending', 0, 1, 1);
    run('INSERT INTO attention_ack (account_id, session_id, phase, since, acked_at) VALUES (?, ?, ?, ?, ?)', 'u1', s1.value.id, 'waiting', 1, 1);
    run('INSERT INTO agent_group_deliveries (id, group_id, thread_id, session_id, status, doc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'gd1', 'gr1', 'th1', s1.value.id, 'pending', '{}', 1);
    run('INSERT INTO agent_group_sessions (group_id, role, session_id) VALUES (?, ?, ?)', 'gr1', 'lead', s1.value.id);
    const message = (id: string, from: string, target: string) =>
      run('INSERT INTO agent_messages (id, trace_id, depth, project_id, kind, from_session_id, on_behalf_of, to_address, target_session_id, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, 'tr1', 0, project.value.id, 'message', from, from, '', target, 'x', 'delivered', 1, 1);
    message('m1', s1.value.id, s2.value.id);
    message('m2', s2.value.id, s1.value.id);
    message('m3', s2.value.id, s2.value.id);
    run('INSERT INTO agent_spawns (session_id, project_id, role, spawner_session_id, trace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', s1.value.id, project.value.id, 'helper', s2.value.id, 'tr1', 1);
    run('INSERT INTO agent_spawns (session_id, project_id, role, spawner_session_id, trace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', s2.value.id, project.value.id, 'helper', s1.value.id, 'tr1', 1);
    run('INSERT INTO agent_task_request (id, account_id, session_id, project_id, title, goal, counted, approval, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'r1', 'u1', s1.value.id, project.value.id, 't', 'g', 0, 'auto', 1, 1);
    run('INSERT INTO session_provenance (session_id, id, task_id, actor_kind, actor_id, actor_name, via, parent_session, parent_seq, authority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', s1.value.id, 'p1', task.value.id, 'user', 'u1', 'U', 'web', s2.value.id, 1, 'user', 1);
    run('INSERT INTO access_grants (subject_id, permission, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?)', 'u2', 'session.prompt', 'session', s1.value.id, 1);
    run('INSERT INTO access_grants (subject_id, permission, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?)', 'u2', 'project.read', 'project', project.value.id, 1);
    run('INSERT INTO access_grants (subject_id, permission, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?)', 'u2', 'session.prompt', 'session', 'other-session', 1);
    run('INSERT INTO task_pull_requests (id, session_id) VALUES (?, ?)', 'pr1', s1.value.id);
    run('INSERT INTO task_log_entries (id, task_id, seq, author, kind, body, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'l1', task.value.id, 1, 'u1', 'note', 'body', s1.value.id, 1);
    run('INSERT INTO task_dispatch (id, task_id, account_id, project_id, title, goal, human, notify_session_id, state, session_id, notified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'td1', task.value.id, 'u1', project.value.id, 't', 'g', 1, s1.value.id, 'running', s1.value.id, 0, 1, 1);
    run('INSERT INTO connector_binding (id, connector, kind, agent_project_id, agent_name, project_id, name, target, params, enabled, consecutive_failures, main_session_id, created_by, time_zone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'cb1', 'slack', 'dm', 'ap1', 'bot', project.value.id, 'n', 'T1', '{}', 1, 0, s1.value.id, 'u1', 'Asia/Shanghai', 1, 1);
    run('INSERT INTO trigger_run (id, binding_id, external_id, catchup, state, session_id, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'tr1', 'cb1', 'e1', 0, 'delivered', s1.value.id, 'go', 1, 1);

    await store.sessions.remove(s1.value.id);

    assert.equal(await store.sessions.byId(s1.value.id), null);
    assert.ok(await store.sessions.byId(s2.value.id));
    for (const table of ['journal', 'session_text', 'entry_map', 'artifacts', 'session_git_bases', 'session_assets', 'turn_checkpoints', 'turn_refs', 'tool_grants', 'tool_calls', 'message_delivery', 'attention_ack', 'agent_group_deliveries', 'agent_group_sessions', 'agent_task_request', 'session_provenance']) {
      assert.equal(count(db, table, 'session_id = ?', s1.value.id), 0, `${table} 应该清空`);
    }
    assert.equal(count(db, 'task_pull_requests', 'session_id = ?', s1.value.id), 0);
    assert.equal(count(db, 'access_grants', "resource_type = 'session' AND resource_id = ?", s1.value.id), 0, '会话上的显式授权也要清');
    assert.equal(count(db, 'access_grants'), 2, '项目授权和别的会话授权不动');
    assert.equal(count(db, 'agent_messages'), 1, '只留下与已删会话无关的那条');
    assert.equal(count(db, 'agent_spawns'), 0, '作为派生者 / 被派生者都要删');
    // 连线只删涉及 s1 的两端；s2 那一端的无关连线还在
    assert.equal(count(db, 'session_links'), 1);
    assert.equal(count(db, 'session_links', 'a_session_id = ? AND b_session_id = ?', s2.value.id, 's3'), 1);
    // 可空引用置 NULL，记录本身保留
    assert.equal((db.prepare('SELECT session_id FROM task_log_entries WHERE id = ?').get('l1') as { session_id: string | null }).session_id, null);
    const dispatch = db.prepare('SELECT session_id, notify_session_id FROM task_dispatch WHERE id = ?').get('td1') as { session_id: string | null; notify_session_id: string | null };
    assert.equal(dispatch.session_id, null);
    assert.equal(dispatch.notify_session_id, null);
    assert.equal((db.prepare('SELECT main_session_id FROM connector_binding WHERE id = ?').get('cb1') as { main_session_id: string | null }).main_session_id, null);
    assert.equal((db.prepare('SELECT session_id FROM trigger_run WHERE id = ?').get('tr1') as { session_id: string | null }).session_id, null);
    // Task 和项目不动
    assert.ok(await store.tasks.byId(task.value.id));
    assert.ok(await store.projects.byId(project.value.id));
    // 再删一次不报错（幂等）
    await store.sessions.remove(s1.value.id);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
