import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve } from 'node:path';

export type CheckpointKind = 'task.create' | 'session.start' | 'session.send';
export type CheckpointState = 'pending' | 'accepted' | 'rejected' | 'unknown';
export interface CheckpointTarget { projectId?: string; taskId?: string; sessionId?: string; workerId?: string; workspaceId?: string }
export interface CheckpointReceipt { taskId?: string; sessionId?: string; turn?: number; seq?: number; deliveryId?: string; code?: string }
export interface Checkpoint {
  version: 1;
  hubUrl: string;
  principal: string;
  operationId: string;
  kind: CheckpointKind;
  target: CheckpointTarget;
  requestDigest: { version: 1; algorithm: 'hmac-sha256'; value: string };
  state: CheckpointState;
  receipt?: CheckpointReceipt;
  createdAt: string;
  updatedAt: string;
}
export interface CheckpointStore {
  begin(input: { hubUrl: string; principal: string; operationId: string; kind: CheckpointKind; target: CheckpointTarget; request: unknown }): Promise<Checkpoint>;
  record(operationId: string, update: { state: 'accepted' | 'rejected' | 'unknown'; receipt?: CheckpointReceipt }): Promise<Checkpoint>;
  get(operationId: string): Promise<Checkpoint | undefined>;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const targetKeys = ['projectId', 'taskId', 'sessionId', 'workerId', 'workspaceId'];
const receiptKeys = ['taskId', 'sessionId', 'turn', 'seq', 'deliveryId', 'code'];
const kinds = ['task.create', 'session.start', 'session.send'];
const states = ['pending', 'accepted', 'rejected', 'unknown'];

function safeId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !idPattern.test(value) || /^ahp_/i.test(value)) throw new Error('Invalid checkpoint identifier');
}
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid checkpoint fields');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key))) throw new Error('Invalid checkpoint fields');
  return result;
}
function cleanTarget(value: unknown): CheckpointTarget {
  const input = fields(value, targetKeys);
  const result: Record<string, string> = {};
  for (const key of targetKeys) if (input[key] !== undefined) { safeId(input[key]); result[key] = input[key]; }
  return result;
}
function cleanReceipt(value: unknown): CheckpointReceipt {
  const input = fields(value, receiptKeys);
  const result: Record<string, string | number> = {};
  for (const key of receiptKeys) {
    const item = input[key];
    if (item === undefined) continue;
    if (key === 'turn' || key === 'seq') {
      if (!Number.isSafeInteger(item) || (item as number) < 0) throw new Error('Invalid checkpoint receipt');
      result[key] = item as number;
    } else if (key === 'code') {
      if (typeof item !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(item)) throw new Error('Invalid checkpoint code');
      result[key] = item;
    } else { safeId(item); result[key] = item; }
  }
  return result;
}
// Canonical JSON is deliberately restricted to plain JSON data; no toJSON hooks.
function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || seen.has(value)) throw new Error('Invalid checkpoint request');
  seen.add(value);
  let output: string;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error('Invalid checkpoint request');
    output = `[${value.map(item => canonical(item, seen)).join(',')}]`;
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid checkpoint request');
    const object = value as Record<string, unknown>;
    output = `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return output;
}
function mac(key: Buffer, domain: string, value: string): string {
  return createHmac('sha256', key).update(domain).update('\0').update(value).digest('hex');
}
function normalizeUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid checkpoint hub URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid checkpoint hub URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid checkpoint hub URL');
  return url.toString().replace(/\/$/, '');
}
function checkPrivate(stat: { isDirectory(): boolean; isFile(): boolean; mode: number; uid: number }, directory: boolean): void {
  if (!(directory ? stat.isDirectory() : stat.isFile()) || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Unsafe checkpoint storage permissions');
}
async function prepareDirectory(path: string): Promise<void> {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Unsafe checkpoint directory');
  }
  checkPrivate(await lstat(path), true);
}
async function readPrivate(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { checkPrivate(await handle.stat(), false); return await handle.readFile(); } finally { await handle.close(); }
}
async function writeTemporary(directory: string, data: string | Buffer): Promise<string> {
  const path = join(directory, `.tmp-${randomBytes(16).toString('hex')}`);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(data); await handle.sync(); } catch (error) { await handle.close(); await unlink(path); throw error; }
  await handle.close();
  return path;
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
function verifyCheckpoint(value: unknown): Checkpoint {
  const obj = fields(value, ['version', 'hubUrl', 'principal', 'operationId', 'kind', 'target', 'requestDigest', 'state', 'receipt', 'createdAt', 'updatedAt']);
  if (obj.version !== 1 || typeof obj.hubUrl !== 'string' || normalizeUrl(obj.hubUrl) !== obj.hubUrl || !kinds.includes(obj.kind as string) || !states.includes(obj.state as string)) throw new Error('Invalid checkpoint');
  safeId(obj.principal); safeId(obj.operationId); cleanTarget(obj.target);
  const digest = fields(obj.requestDigest, ['version', 'algorithm', 'value']);
  if (digest.version !== 1 || digest.algorithm !== 'hmac-sha256' || typeof digest.value !== 'string' || !digestPattern.test(digest.value)) throw new Error('Invalid checkpoint');
  if (obj.receipt !== undefined) cleanReceipt(obj.receipt);
  if (typeof obj.createdAt !== 'string' || typeof obj.updatedAt !== 'string' || !Number.isFinite(Date.parse(obj.createdAt)) || !Number.isFinite(Date.parse(obj.updatedAt))) throw new Error('Invalid checkpoint');
  return obj as unknown as Checkpoint;
}

export function checkpointStore(options: { directory?: string } = {}): CheckpointStore {
  let directory = options.directory;
  if (directory === undefined) {
    const xdg = process.env.XDG_STATE_HOME;
    const home = process.env.HOME;
    if (xdg && isAbsolute(xdg)) directory = join(xdg, 'agent-hub', 'checkpoints');
    else if (home && isAbsolute(home)) directory = join(home, '.local', 'state', 'agent-hub', 'checkpoints');
    else throw new Error('No absolute checkpoint state directory');
  }
  if (!isAbsolute(directory)) throw new Error('Checkpoint directory must be absolute');
  directory = resolve(directory);
  const dir = directory;
  const pathFor = (id: string) => { safeId(id); return join(dir, `operation-${id}.json`); };
  async function withLock<T>(fn: (key: Buffer) => Promise<T>): Promise<T> {
    await prepareDirectory(dir);
    const lock = join(dir, '.lock');
    let handle;
    try { handle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Checkpoint store is locked; inspect the lock after interruption');
      throw error;
    }
    try {
      const keyPath = join(dir, 'key');
      let key: Buffer;
      try { key = await readPrivate(keyPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if ((await readdir(dir)).some(name => name.startsWith('operation-'))) throw new Error('Checkpoint key is missing');
        const tmp = await writeTemporary(dir, randomBytes(32));
        try { await link(tmp, keyPath); await syncDirectory(dir); } finally { await unlink(tmp); }
        key = await readPrivate(keyPath);
      }
      if (key.length !== 32) throw new Error('Invalid checkpoint key');
      return await fn(key);
    } finally { await handle.close(); await unlink(lock); }
  }
  async function load(id: string, key: Buffer): Promise<Checkpoint | undefined> {
    let contents: Buffer;
    try { contents = await readPrivate(pathFor(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    try {
      const envelope = fields(JSON.parse(contents.toString('utf8')), ['checkpoint', 'mac']);
      const checkpoint = verifyCheckpoint(envelope.checkpoint);
      if (checkpoint.operationId !== id || typeof envelope.mac !== 'string' || !digestPattern.test(envelope.mac)) throw new Error('Invalid checkpoint');
      const expected = Buffer.from(mac(key, 'checkpoint-v1', canonical(checkpoint)), 'hex');
      if (!timingSafeEqual(expected, Buffer.from(envelope.mac, 'hex'))) throw new Error('Invalid checkpoint');
      return checkpoint;
    } catch { throw new Error('Checkpoint integrity invalid'); }
  }
  async function save(checkpoint: Checkpoint, key: Buffer, create: boolean): Promise<void> {
    const path = pathFor(checkpoint.operationId);
    const data = JSON.stringify({ checkpoint, mac: mac(key, 'checkpoint-v1', canonical(checkpoint)) }) + '\n';
    const tmp = await writeTemporary(dir, data);
    try { if (create) await link(tmp, path); else await rename(tmp, path); await syncDirectory(dir); }
    finally { try { await unlink(tmp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  }
  return {
    async begin(input) {
      const obj = fields(input, ['hubUrl', 'principal', 'operationId', 'kind', 'target', 'request']);
      safeId(obj.principal); safeId(obj.operationId);
      if (!kinds.includes(obj.kind as string)) throw new Error('Invalid checkpoint kind');
      const hubUrl = normalizeUrl(obj.hubUrl);
      const target = cleanTarget(obj.target);
      const request = canonical(obj.request);
      return withLock(async key => {
        const now = new Date().toISOString();
        const checkpoint: Checkpoint = { version: 1, hubUrl, principal: obj.principal as string, operationId: obj.operationId as string, kind: obj.kind as CheckpointKind, target, requestDigest: { version: 1, algorithm: 'hmac-sha256', value: mac(key, 'request-v1', request) }, state: 'pending', createdAt: now, updatedAt: now };
        await save(checkpoint, key, true);
        return checkpoint;
      });
    },
    async record(operationId, update) {
      pathFor(operationId);
      const obj = fields(update, ['state', 'receipt']);
      if (!['accepted', 'rejected', 'unknown'].includes(obj.state as string)) throw new Error('Invalid checkpoint state');
      const receipt = obj.receipt === undefined ? undefined : cleanReceipt(obj.receipt);
      return withLock(async key => {
        const checkpoint = await load(operationId, key);
        if (!checkpoint) throw new Error('Checkpoint not found');
        if (checkpoint.state === 'accepted' || checkpoint.state === 'rejected') throw new Error('Checkpoint is terminal');
        const previous = checkpoint.receipt ?? {};
        for (const [name, value] of Object.entries(receipt ?? {})) if (name in previous && previous[name as keyof CheckpointReceipt] !== value) throw new Error('Conflicting checkpoint evidence');
        checkpoint.state = obj.state as CheckpointState;
        if (receipt !== undefined) checkpoint.receipt = { ...previous, ...receipt };
        checkpoint.updatedAt = new Date().toISOString();
        await save(checkpoint, key, false);
        return checkpoint;
      });
    },
    async get(operationId) {
      const path = pathFor(operationId);
      await prepareDirectory(dir);
      let key: Buffer;
      try { key = await readPrivate(join(dir, 'key')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try { await lstat(path); } catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw missing; }
        throw new Error('Checkpoint key is missing');
      }
      if (key.length !== 32) throw new Error('Invalid checkpoint key');
      return load(operationId, key);
    },
  };
}
