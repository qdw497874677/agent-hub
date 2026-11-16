import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import type { AuditEntry } from '../account.ts';
import { asAgentId, type SessionId } from '../ids.ts';
import { capabilityMatrix, available } from '../capability.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { ok } from '../result.ts';
import type { CheckpointStore, TurnCheckpoint, WorkspaceBrowser } from '../ports/workspace-browser.ts';
import type { ToolContext } from '../ports/tool-provider.ts';
import type { ToolScope } from '../tool.ts';
import { createProjectUseCase } from '../use-cases/projects.ts';
import { createTaskUseCase } from '../use-cases/tasks.ts';
import { deriveSessionUseCase } from '../use-cases/sessions.ts';
import { createWorkspaceFilesService } from '../use-cases/workspace-files.ts';
import { FILES_LIMITS } from '../workspace-files.ts';
import { WORKSPACE_FILE_LIMITS, WORKSPACE_TOOLS, createWorkspaceToolProvider } from './files-tools.ts';

const agent: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: capabilityMatrix({ prompt: available, interrupt: available, fork: available, resume: available, tool_calls: available, artifacts: available, structured_events: available, attachments: available }),
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

interface FakeFile {
  readonly bytes: Uint8Array;
  readonly binary?: boolean;
}

function fakeBrowser(state: { calls: string[]; entries: number; files: Record<string, FakeFile> }): WorkspaceBrowser {
  return {
    list: async (root, path, options) => {
      state.calls.push(`list:${root}:${path}`);
      const all = Array.from({ length: state.entries }, (_, index) => ({
        name: `f${index}.ts`,
        path: path ? `${path}/f${index}.ts` : `f${index}.ts`,
        type: 'file' as const,
        size: index,
        modifiedAt: 1000 + index,
        ignored: false,
        sensitive: index === 0,
        git: null
      }));
      const limit = options?.limit ?? all.length;
      return ok({ path, entries: all.slice(0, limit), truncated: all.length > limit, isGit: true });
    },
    read: async (_root, path, maxBytes) => {
      state.calls.push(`read:${path}:${maxBytes ?? 'all'}`);
      const file = state.files[path];
      if (!file) return ok({ path, size: 0, modifiedAt: 0, binary: false, truncated: false, bytes: new Uint8Array() });
      const cut = Math.min(maxBytes ?? file.bytes.length, file.bytes.length);
      return ok({
        path,
        size: file.bytes.length,
        modifiedAt: 1234,
        binary: file.binary ?? false,
        truncated: file.bytes.length > cut,
        bytes: file.bytes.subarray(0, cut)
      });
    },
    find: async () => ok([]),
    changes: async () => ok([]),
    diff: async (_root, path) => ok({ path, patch: '', truncated: false, binary: false }),
    checkpoint: async () => ok('c0ffee'),
    dropRefs: async () => ok(0),
    restore: async () => ok({ safety: 'safe', restored: 0, removed: 0 }),
    head: async () => ok('abc1234'),
    branchBase: async () => ok({ branch: 'main', commit: 'abc1234' }),
    watch: async () => ok(() => undefined)
  };
}

function memoryCheckpoints(): CheckpointStore {
  const rows: TurnCheckpoint[] = [];
  return {
    list: async (id) => rows.filter((row) => row.sessionId === id),
    begin: async (row) => void rows.push({ ...row, after: null, endedAt: null, files: null, additions: null, deletions: null }),
    end: async () => undefined,
    staleSessions: async () => [],
    remove: async (id) => void rows.splice(0, rows.length, ...rows.filter((row) => row.sessionId !== id))
  };
}

async function world(entries = 3, files: Record<string, FakeFile> = {}) {
  const w = inMemoryDeps({ now: () => 1000 });
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo/' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  const state = { calls: [] as string[], entries, files };
  const audits: AuditEntry[] = [];
  const bases = new Map<string, string>();
  const filesService = createWorkspaceFilesService({
    ...w.deps,
    audit: { append: async (entry) => void audits.push(entry) },
    local: fakeBrowser(state),
    remote: () => fakeBrowser(state),
    bases: { get: async (id) => bases.get(id) ?? null, setIfAbsent: async (id, head) => void (bases.has(id) || bases.set(id, head)) },
    checkpoints: memoryCheckpoints(),
    now: () => 1000
  });
  const provider = createWorkspaceToolProvider({ files: filesService, subjectOf: async () => null });
  return { ...w, provider, state, audits, task: task.value, session: session.value, project: project.value };
}

const ctx = (sessionId: SessionId, taskId: string | null, scopes: ToolScope[]): ToolContext => ({
  grant: { id: 'g1', tokenHash: 'h', taskId: taskId as never, sessionId, workerId: null, scopes, createdAt: 0, expiresAt: 1e12, revokedAt: null },
  now: 1000
});

const scopes: ToolScope[] = ['files'];
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

test('工具清单：workspace.list / workspace.read，scope files，限流 30', () => {
  assert.deepEqual(WORKSPACE_TOOLS.map((tool) => tool.name), ['workspace.list', 'workspace.read']);
  for (const tool of WORKSPACE_TOOLS) {
    assert.equal(tool.scope, 'files');
    assert.equal(tool.perMinute, 30);
    for (const section of ['何时用', '参数', '返回', '下一步与错误']) assert.ok(tool.description.includes(section), `${tool.name} 缺 ${section}`);
  }
  const read = WORKSPACE_TOOLS.find((tool) => tool.name === 'workspace.read')!;
  assert.deepEqual(read.inputSchema['required'], ['path']);
  assert.equal(WORKSPACE_FILE_LIMITS.defaultReadBytes, 64 * 1024);
  assert.equal(WORKSPACE_FILE_LIMITS.maxReadBytes, 256 * 1024);
  assert.equal(WORKSPACE_FILE_LIMITS.listEntries, 200);
});

test('workspace.list：默认根目录，最多 200 条，标记 truncated / sensitive', async () => {
  const w = await world(250);
  const got = await w.provider.call('workspace.list', {}, ctx(w.session.id, w.task.id, scopes));
  assert.ok(got.ok);
  const page = got.value as { path: string; entries: Array<Record<string, unknown>>; total: number; truncated: boolean };
  assert.equal(page.path, '');
  assert.equal(page.entries.length, 200);
  assert.equal(page.total, 250);
  assert.equal(page.truncated, true);
  assert.deepEqual(page.entries[0], { name: 'f0.ts', type: 'file', size: 0, modified_at: 1000, sensitive: true });
  assert.deepEqual(w.state.calls, ['list:/tmp/demo:']);

  const sub = await w.provider.call('workspace.list', { path: 'src' }, ctx(w.session.id, w.task.id, scopes));
  assert.ok(sub.ok);
  assert.equal((sub.value as { path: string }).path, 'src');
  assert.deepEqual(w.state.calls.at(-1), 'list:/tmp/demo:src');
});

test('workspace.list：路径逃逸、未知字段、未知工具都拒', async () => {
  const w = await world();
  const c = ctx(w.session.id, w.task.id, scopes);
  for (const path of ['../etc', '/etc', '.git']) {
    const got = await w.provider.call('workspace.list', { path }, c);
    assert.equal(got.ok, false, path);
    assert.equal((got as { error: { code: string } }).error.code, 'invalid', path);
  }
  assert.equal(((await w.provider.call('workspace.list', { depth: 2 }, c)) as { error: { code: string } }).error.code, 'invalid');
  const unknown = await w.provider.call('workspace.write', {}, c);
  assert.equal((unknown as { error: { code: string; message: string } }).error.message, '没有这个工具：workspace.write');
});

test('workspace.read：默认 64 KiB，给 maxBytes 就按它截断并标 truncated', async () => {
  const big = new Uint8Array(300_000).fill(65);
  const w = await world(1, { 'big.txt': { bytes: big }, 'a.txt': { bytes: text('hello 世界') } });
  const c = ctx(w.session.id, w.task.id, scopes);

  const full = await w.provider.call('workspace.read', { path: 'a.txt' }, c);
  assert.ok(full.ok);
  assert.deepEqual(full.value, { path: 'a.txt', size: text('hello 世界').length, modified_at: 1234, binary: false, truncated: false, content: 'hello 世界' });
  // service 固定按 1 MiB 预览上限读，工具层再收到 64 KiB。
  assert.equal(w.state.calls.at(-1), `read:a.txt:${FILES_LIMITS.previewBytes}`);

  const cut = await w.provider.call('workspace.read', { path: 'a.txt', maxBytes: 4 }, c);
  assert.ok(cut.ok);
  assert.equal((cut.value as { content: string }).content, 'hell');
  assert.equal((cut.value as { truncated: boolean }).truncated, true);
  assert.equal((cut.value as { size: number }).size, text('hello 世界').length);

  // 超过上限按 256 KiB 截断，而不是报错。
  const capped = await w.provider.call('workspace.read', { path: 'big.txt', maxBytes: 10_000_000 }, c);
  assert.ok(capped.ok);
  const page = capped.value as { content: string; truncated: boolean };
  assert.equal(page.content.length, WORKSPACE_FILE_LIMITS.maxReadBytes);
  assert.equal(page.truncated, true);
  assert.equal(w.state.calls.at(-1), `read:big.txt:${FILES_LIMITS.previewBytes}`);
});

test('workspace.read：二进制只给标记，敏感文件不由 agent 确认，参数严格', async () => {
  const w = await world(1, { 'logo.png': { bytes: new Uint8Array([1, 0, 2]), binary: true }, '.env': { bytes: text('TOKEN=1') } });
  const c = ctx(w.session.id, w.task.id, scopes);

  const binary = await w.provider.call('workspace.read', { path: 'logo.png' }, c);
  assert.ok(binary.ok);
  assert.deepEqual(binary.value, { path: 'logo.png', size: 3, modified_at: 1234, binary: true, truncated: false, content: '' });

  const secret = await w.provider.call('workspace.read', { path: '.env' }, c);
  assert.equal(secret.ok, false);
  assert.equal((secret as { error: { code: string } }).error.code, 'invalid');
  assert.equal((secret as { error: { message: string } }).error.message, '这是敏感文件（可能含密钥），确认后才能打开');
  assert.equal(w.audits.length, 0);

  for (const input of [{}, { path: '' }, { path: '../x' }, { path: '/etc/passwd' }, { path: 'a.txt', maxBytes: 0 }, { path: 'a.txt', maxBytes: 1.5 }, { path: 'a.txt', junk: true }]) {
    const got = await w.provider.call('workspace.read', input, c);
    assert.equal(got.ok, false, JSON.stringify(input));
    assert.equal((got as { error: { code: string } }).error.code, 'invalid', JSON.stringify(input));
  }
});
