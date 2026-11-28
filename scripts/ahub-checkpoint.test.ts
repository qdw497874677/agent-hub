import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkpointStore } from './ahub-checkpoint.ts';

async function fixture(fn: (directory: string) => Promise<void>) {
  const directory = await mkdtemp('/tmp/opencode/ahub-checkpoint-');
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const intent = { hubUrl: 'https://hub.example/prefix/', principal: 'user-1:token-1', operationId: 'op-1', kind: 'session.send' as const, target: { projectId: 'project-1', sessionId: 'session-1' }, request: { prompt: 'secret prompt sentinel', nested: { b: 2, a: 1 } } };

test('persists authenticated intent and sanitized evidence without request material', () => fixture(async directory => {
  const store = checkpointStore({ directory });
  const pending = await store.begin(intent);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.hubUrl, 'https://hub.example/prefix');
  assert.equal((await checkpointStore({ directory }).get('op-1'))?.state, 'pending');
  const result = await store.record('op-1', { state: 'unknown', receipt: { seq: 3 } });
  assert.deepEqual(result.receipt, { seq: 3 });
  const accepted = await store.record('op-1', { state: 'accepted', receipt: { taskId: 'task-new', sessionId: 'session-new', turn: 4, deliveryId: 'delivery-1', code: 'HTTP_202' } });
  assert.deepEqual(accepted.receipt, { seq: 3, taskId: 'task-new', sessionId: 'session-new', turn: 4, deliveryId: 'delivery-1', code: 'HTTP_202' });
  assert.deepEqual(await checkpointStore({ directory }).get('op-1'), accepted);
  await assert.rejects(store.record('op-1', { state: 'rejected' }), /terminal/);
  await assert.rejects(store.begin(intent), /EEXIST/);
  const disk = await readFile(join(directory, 'operation-op-1.json'), 'utf8');
  assert.ok(!disk.includes('secret prompt sentinel'));
  assert.ok(!disk.includes(createHash('sha256').update(JSON.stringify(intent.request)).digest('hex')));
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  for (const name of await readdir(directory)) assert.equal((await lstat(join(directory, name))).mode & 0o777, 0o600);
}));

test('HMAC is canonical, keyed per store, and unknown evidence cannot be overwritten', () => fixture(async directory => {
  const store = checkpointStore({ directory });
  const first = await store.begin(intent);
  const second = await store.begin({ ...intent, operationId: 'op-2', request: { nested: { a: 1, b: 2 }, prompt: 'secret prompt sentinel' } });
  assert.equal(first.requestDigest.value, second.requestDigest.value);
  await store.record('op-1', { state: 'unknown', receipt: { seq: 3 } });
  await assert.rejects(store.record('op-1', { state: 'accepted', receipt: { seq: 4 } }), /Conflicting/);
  assert.equal((await store.get('op-1'))?.state, 'unknown');
  await fixture(async other => assert.notEqual((await checkpointStore({ directory: other }).begin(intent)).requestDigest.value, first.requestDigest.value));
}));

test('refuses modified checkpoint, missing key, symlinks and unsafe permissions', () => fixture(async directory => {
  const store = checkpointStore({ directory });
  await store.begin(intent);
  const path = join(directory, 'operation-op-1.json');
  const saved = await readFile(path, 'utf8');
  await writeFile(path, saved.replace('"state":"pending"', '"state":"accepted"'));
  await assert.rejects(store.get('op-1'), /integrity/);
  await assert.rejects(store.record('op-1', { state: 'unknown' }), /integrity/);
  await writeFile(path, saved);
  await chmod(path, 0o644);
  await assert.rejects(store.get('op-1'), /permissions/);
  await chmod(path, 0o600);
  await rm(join(directory, 'key'));
  await assert.rejects(store.get('op-1'), /key is missing/);
  await fixture(async other => {
    await symlink(directory, join(other, 'link'));
    await assert.rejects(checkpointStore({ directory: join(other, 'link', 'state') }).get('op-1'), /Unsafe checkpoint directory/);
    const s = checkpointStore({ directory: other });
    await s.begin(intent);
    await rm(join(other, 'operation-op-1.json'));
    await symlink(path, join(other, 'operation-op-1.json'));
    await assert.rejects(s.get('op-1'));
  });
}));

test('rejects unsafe identifiers, URLs, arbitrary evidence and invalid request values', () => fixture(async directory => {
  const store = checkpointStore({ directory });
  for (const input of [
    { ...intent, operationId: '../escape' }, { ...intent, principal: 'ahp_secret' },
    { ...intent, hubUrl: 'https://user:password@hub.example/' }, { ...intent, hubUrl: 'https://hub.example/?token=secret' },
    { ...intent, target: { sessionId: 'bad id' } }, { ...intent, request: { invalid: undefined } },
  ]) await assert.rejects(store.begin(input));
  await store.begin(intent);
  await assert.rejects(store.record('op-1', { state: 'accepted', receipt: { turn: '4' } } as never));
  await assert.rejects(store.record('op-1', { state: 'rejected', receipt: { code: 'raw error message' } }));
  await assert.rejects(store.record('op-1', { state: 'accepted', receipt: { body: 'secret' } } as never));
  assert.equal((await store.get('op-1'))?.state, 'pending');
  assert.equal(await store.get('missing'), undefined);
  assert.throws(() => checkpointStore({ directory: 'relative' }), /absolute/);
}));

test('a stale writer lock never prevents read-only recovery or permits another write', () => fixture(async directory => {
  const store = checkpointStore({ directory });
  await store.begin(intent);
  await writeFile(join(directory, '.lock'), '', { mode: 0o600 });
  assert.equal((await checkpointStore({ directory }).get('op-1'))?.state, 'pending');
  await assert.rejects(store.record('op-1', { state: 'unknown' }), /locked/);
}));
