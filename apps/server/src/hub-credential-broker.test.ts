import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStore } from '@agent-hub/storage-sqlite';
import { createHubCredentialBroker, installHubCredentialBindingLifecycle } from './hub-credential-broker.ts';

const yes = async () => true;
function setup(audit?: import('./hub-credential-broker.ts').HubCredentialBrokerOptions['audit']) {
  const db = new DatabaseSync(':memory:');
  let target = { teamId: 'team', repoUrl: 'https://git.example/Team/Repo.git', branch: 'main' as string | null };
  let calls = 0;
  let read = async () => ({ ok: true as const, result: { branch: 'main', tip: 'abc', kind: 'text' as const, path: 'x', content: 'content' } });
  const options = { db, key: Buffer.alloc(32, 1), allowedOrigins: ['https://git.example'], resolveTarget: async () => target, allows: () => true, audit,
    check: async () => { calls++; return { reachable: true, branchExists: true, defaultBranch: 'main', message: null }; },
    read: async () => { calls++; return read(); } };
  const broker = createHubCredentialBroker(options);
  return { db, options, broker, setTarget: (value: typeof target) => { target = value; }, setRead: (value: typeof read) => { read = value; }, calls: () => calls };
}

test('encrypted storage, independent bindings, rotation and revoke', async () => {
  const s = setup(); const b = s.broker;
  await b.create('p', 'a', 'Shared', 'fake-secret', yes);
  const listed = await b.list('p', 'a', yes); const id = listed.binding!.credentialId;
  assert.equal(JSON.stringify(listed).includes('fake-secret'), false);
  const stored = s.db.prepare('SELECT cipher FROM hub_credentials').get() as { cipher: string };
  assert.equal(stored.cipher.includes('fake-secret'), false);
  await b.bind('p', 'b', id, yes); assert.equal((await b.check('p', 'b', yes)).status, 'ok');
  assert.deepEqual(await b.rotate('p', 'a', 'fake-new-secret', id, 1, yes), { ok: true, version: 2, affectedBindings: 2 });
  assert.equal((await b.list('p', 'b', yes)).binding?.version, 2);
  await assert.rejects(b.rotate('p', 'a', 'fake-new-secret', 'wrong-id', 2, yes));
  await assert.rejects(b.revoke('p', 'a', id, 1, yes));
  assert.deepEqual(await b.revoke('p', 'a', id, 2, yes), { ok: true, version: 3, affectedBindings: 2 });
  await assert.rejects(b.check('p', 'b', yes));
  assert.throws(() => createHubCredentialBroker({ ...s.options, key: Buffer.alloc(32, 2) }), /key unavailable/);
  s.db.close();
});

test('audit records bounded context and metadata without credential or content', async () => {
  const events: import('./hub-credential-broker.ts').HubCredentialAuditEvent[] = [];
  const s = setup((event) => { events.push(event); }); const b = s.broker;
  const context = { actorId: 'user', sessionId: 'session' };
  await b.create('p', 'a', 'Name', 'fake-secret', yes, context);
  const id = (await b.list('p', 'a', yes)).binding!.credentialId;
  await b.check('p', 'a', yes, context);
  await b.readRepo({ projectId: 'p', repoId: 'a', branch: 'main', path: 'x', expectedTip: null, reauthorize: yes, auditContext: context });
  await b.rotate('p', 'a', 'fake-new-secret', id, 1, yes, context);
  assert.deepEqual(events.map((event) => event.operation), ['create', 'check', 'read', 'rotate']);
  assert.ok(events.every((event) => event.context?.actorId === 'user' && event.context.sessionId === 'session'));
  assert.equal(JSON.stringify(events).includes('fake-secret'), false);
  assert.equal(JSON.stringify(events).includes('content'), false);
  assert.equal(events[3]?.version, 2); s.db.close();
});

test('wrong team, case-sensitive target and live authorization prevent outbound', async () => {
  const s = setup(); const b = s.broker; await b.create('p', 'a', 'Shared', 'fake-secret', yes);
  s.setTarget({ teamId: 'team', repoUrl: 'https://git.example/team/Repo.git', branch: 'main' });
  await assert.rejects(b.check('p', 'a', yes));
  s.setTarget({ teamId: 'other', repoUrl: 'https://git.example/Team/Repo.git', branch: 'main' });
  await assert.rejects(b.check('p', 'a', yes));
  await assert.rejects(b.check('p', 'a', async () => false)); assert.equal(s.calls(), 0); s.db.close();
});

test('in-flight rotation and authorization changes suppress stale results', async () => {
  const s = setup(); const b = s.broker; await b.create('p', 'a', 'Shared', 'fake-secret', yes);
  const id = (await b.list('p', 'a', yes)).binding!.credentialId;
  let release!: () => void; let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  s.setRead(async () => { started(); await gate; return { ok: true, result: { branch: 'main', tip: 'abc', kind: 'text', path: 'x', content: 'old' } }; });
  const pending = b.readRepo({ projectId: 'p', repoId: 'a', branch: 'main', path: 'x', expectedTip: null, reauthorize: yes });
  await entered; await b.rotate('p', 'a', 'fake-new-secret', id, 1, yes); release(); assert.equal((await pending).ok, false);
  s.db.close();
});

test('default branch discovery is reauthorized and targets reject path ambiguity', async () => {
  const s = setup(); const b = s.broker; await b.create('p', 'a', 'Shared', 'fake-secret', yes);
  s.setTarget({ teamId: 'team', repoUrl: 'https://git.example/Team/Repo.git', branch: null });
  const result = await b.readRepo({ projectId: 'p', repoId: 'a', branch: null, path: 'x', expectedTip: null, reauthorize: yes });
  assert.equal(result.ok, true); assert.equal(s.calls(), 2);
  for (const repoUrl of ['https://git.example/', 'https://git.example/Team/%2fRepo', 'https://git.example/Team//Repo', 'https://git.example/Team/Repo/']) {
    s.setTarget({ teamId: 'team', repoUrl, branch: 'main' }); await assert.rejects(b.check('p', 'a', yes));
  }
  assert.equal(s.calls(), 2); s.db.close();
});

test('mutation detects binding change during authorization', async () => {
  const s = setup(); const b = s.broker; await b.create('p', 'a', 'one', 'fake-secret', yes);
  const id = (await b.list('p', 'a', yes)).binding!.credentialId;
  let release!: () => void; let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
  let first = true; const delayed = async () => { if (first) { first = false; started(); await gate; } return true; };
  const pending = b.rotate('p', 'a', 'another-secret', id, 1, delayed);
  await entered; await b.create('p', 'a', 'two', 'new-secret', yes); release(); await assert.rejects(pending);
  assert.equal((await b.list('p', 'a', yes)).binding?.name, 'two'); s.db.close();
});

test('persistent project lifecycle invalidates bindings atomically without deleting credentials', async () => {
  const store = openSqliteStore(':memory:'); const db = store.db;
  const repoA = { id: 'a', name: 'api', url: 'https://git.example/Team/Repo.git', defaultBranch: 'main' };
  const repoB = { id: 'b', name: 'web', url: 'https://git.example/Team/Repo.git', defaultBranch: 'main' };
  const original = JSON.stringify([repoA, repoB]);
  const insert = db.prepare('INSERT INTO projects(id,name,root_path,created_at,team_id,repos,repo_url,repo_default_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('p', 'p', '', 1, 'team', original, repoA.url, 'main');
  insert.run('q', 'q', '', 1, 'team', original, repoA.url, 'main');
  const broker = createHubCredentialBroker({ db, key: Buffer.alloc(32, 1), allowedOrigins: ['https://git.example'],
    resolveTarget: async () => ({ teamId: 'team', repoUrl: repoA.url, branch: 'main' }), allows: () => true,
    check: async () => ({ reachable: true, branchExists: true, defaultBranch: 'main', message: null }),
    read: async () => ({ ok: false, code: 'generic', message: 'unavailable' }) });
  installHubCredentialBindingLifecycle(db); installHubCredentialBindingLifecycle(db);
  await broker.create('p', 'a', 'Shared', 'fake-secret', yes);
  const id = (await broker.list('p', 'a', yes)).binding!.credentialId;
  await broker.bind('p', 'b', id, yes); await broker.bind('q', 'a', id, yes);
  const rows = () => db.prepare('SELECT project_id,repo_id FROM hub_credential_bindings ORDER BY project_id,repo_id').all().map((row) => `${row.project_id}:${row.repo_id}`);
  db.prepare("UPDATE projects SET name='renamed' WHERE id='p'").run();
  db.prepare("UPDATE projects SET repos=repos,team_id=team_id,deleted_at=deleted_at WHERE id='p'").run();
  assert.deepEqual(rows(), ['p:a', 'p:b', 'q:a']);
  db.exec('BEGIN'); db.prepare("UPDATE projects SET repos='[]' WHERE id='p'").run(); assert.deepEqual(rows(), ['q:a']); db.exec('ROLLBACK');
  assert.deepEqual(rows(), ['p:a', 'p:b', 'q:a']);
  const repos = db.prepare("UPDATE projects SET repos=? WHERE id='p'");
  repos.run(JSON.stringify([repoB])); repos.run(original);
  assert.deepEqual(rows(), ['q:a']);
  assert.equal((db.prepare('SELECT count(*) AS n FROM hub_credentials').get() as { n: number }).n, 1);
  await broker.bind('p', 'a', id, yes);
  repos.run(JSON.stringify([{ ...repoA, url: 'https://git.example/Team/Other.git' }, repoB])); repos.run(original);
  assert.deepEqual(rows(), ['q:a']);
  // Invalid or legacy list falls back to repo_url in the real store; either direction fails closed.
  await broker.bind('p', 'a', id, yes); repos.run('{broken'); repos.run(original); assert.deepEqual(rows(), ['q:a']);
  await broker.bind('p', 'a', id, yes); repos.run(null); repos.run(original); assert.deepEqual(rows(), ['q:a']);
  await broker.bind('p', 'a', id, yes);
  db.exec("UPDATE projects SET repo_url='https://git.example/legacy' WHERE id='p'; UPDATE projects SET repo_url='https://git.example/Team/Repo.git' WHERE id='p'");
  assert.deepEqual(rows(), ['q:a']);
  for (const field of ['team_id', 'deleted_at']) {
    await broker.bind('p', 'a', id, yes);
    if (field === 'team_id') db.exec("UPDATE projects SET team_id='other' WHERE id='p'; UPDATE projects SET team_id='team' WHERE id='p'");
    else db.exec("UPDATE projects SET deleted_at=1 WHERE id='p'; UPDATE projects SET deleted_at=NULL WHERE id='p'");
    assert.deepEqual(rows(), ['q:a']);
  }
  await broker.bind('p', 'a', id, yes); db.exec("DELETE FROM projects WHERE id='p'");
  insert.run('p', 'p', '', 1, 'team', original, repoA.url, 'main'); assert.deepEqual(rows(), ['q:a']);
  assert.equal((db.prepare('SELECT count(*) AS n FROM hub_credentials').get() as { n: number }).n, 1);
  store.close();
});

test('project lifecycle epoch rejects delayed create even when no binding existed before and after edit', async () => {
  const store = openSqliteStore(':memory:'); const db = store.db;
  db.exec("INSERT INTO projects(id,name,root_path,created_at,team_id,repos) VALUES ('p','p','',1,'team','[]')");
  const broker = createHubCredentialBroker({ db, key: Buffer.alloc(32, 1), allowedOrigins: ['https://git.example'],
    resolveTarget: async () => ({ teamId: 'team', repoUrl: 'https://git.example/Team/Repo.git', branch: 'main' }), allows: () => true,
    check: async () => ({ reachable: true, branchExists: true, defaultBranch: 'main', message: null }),
    read: async () => ({ ok: false, code: 'generic', message: 'unavailable' }) });
  installHubCredentialBindingLifecycle(db);
  let release!: () => void; let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
  let first = true; const delayed = async () => { if (first) { first = false; started(); await gate; } return true; };
  const pending = broker.create('p', 'a', 'Name', 'fake-secret', delayed);
  await entered; db.exec("UPDATE projects SET repos='[1]' WHERE id='p'; UPDATE projects SET repos='[]' WHERE id='p'");
  release(); await assert.rejects(pending);
  assert.equal((db.prepare('SELECT count(*) AS n FROM hub_credential_bindings').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT count(*) AS n FROM hub_credentials').get() as { n: number }).n, 0);
  store.close();
});

test('project lifecycle discards an in-flight read after repository edit and restore', async () => {
  const store = openSqliteStore(':memory:'); const db = store.db;
  db.exec("INSERT INTO projects(id,name,root_path,created_at,team_id,repos) VALUES ('p','p','',1,'team','[]')");
  let release!: () => void; let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
  const broker = createHubCredentialBroker({ db, key: Buffer.alloc(32, 1), allowedOrigins: ['https://git.example'],
    resolveTarget: async () => ({ teamId: 'team', repoUrl: 'https://git.example/Team/Repo.git', branch: 'main' }), allows: () => true,
    check: async () => ({ reachable: true, branchExists: true, defaultBranch: 'main', message: null }),
    read: async () => { started(); await gate; return { ok: true, result: { branch: 'main', tip: 'abc', kind: 'text', path: 'x', content: 'old' } }; } });
  installHubCredentialBindingLifecycle(db); await broker.create('p', 'a', 'Name', 'fake-secret', yes);
  const pending = broker.readRepo({ projectId: 'p', repoId: 'a', branch: 'main', path: 'x', expectedTip: null, reauthorize: yes });
  await entered; db.exec("UPDATE projects SET repos='[1]' WHERE id='p'; UPDATE projects SET repos='[]' WHERE id='p'");
  release(); assert.equal((await pending).ok, false); store.close();
});
