import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { RpcChannel, ServerToWorker } from '@agent-hub/contract';
import { AsyncQueue, PROJECT_GIT_BUNDLE_MAX_BASE64_BYTES, WORKER_CAPABILITY_BRANCH_ATTEMPT, WORKER_CAPABILITY_DURABLE_DELIVERY, WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT, WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_SESSION_START_NATIVE_REF, WORKER_CAPABILITY_OPTION_RECEIPT, WORKER_CAPABILITY_WORKDIR_TERMINAL_V1, WORKER_CAPABILITY_WORKSPACE_MUTATION_SAFETY_V1, createRpcChannel, serverToWorkerSchema, workerToServerSchema, wsImportProjectGitBundle } from '@agent-hub/contract';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { CAPABILITY_NAMES, asAgentId, asSessionId, available, capabilityMatrix, type AgentRuntime, type Capability, type CapabilityName, type SessionEvent } from '@agent-hub/domain';
import { createServerGateway, type GatewayHooks, type GatewayOptions, type WorkerConnectionObservation } from './server-gateway.ts';
import { connectWorkerLink } from './worker-link.ts';
import { createWorkdirTerminalHost } from './workdir-terminal.ts';
import { serveProjectGitBundleImport } from './worker-fs-rpc.ts';
import { createWorkerFiles } from './worker-files.ts';
import { createGitWorkspace, createGroupWorktrees } from './git-workspace.ts';
import { agentToDto, agentFromDto } from '@agent-hub/contract/codec';
import { agentSchema, workerInfoSchema } from '@agent-hub/contract';
import type { ProjectGitBundleImportInput, ProjectGitBundleImporter } from './project-git-bundle-import.ts';
import type { RuntimeJob } from '@agent-hub/domain';

interface Call {
  readonly method: string;
  readonly params: unknown;
}

interface Wire {
  readonly ws: WebSocket;
  readonly calls: Call[];
  readonly frames: ServerToWorker[];
}

interface HarnessOptions {
  readonly authenticate?: GatewayHooks['authenticate'];
  readonly localSecret?: string;
  readonly token?: string;
  readonly onConnectionObservation?: GatewayHooks['onConnectionObservation'];
  readonly onObservedRuntimeInstall?: GatewayHooks['onObservedRuntimeInstall'];
  readonly onRuntimeJob?: GatewayHooks['onRuntimeJob'];
  readonly onBranchAttemptResult?: GatewayHooks['onBranchAttemptResult'];
  readonly onSessionStartChanged?: GatewayHooks['onSessionStartChanged'];
  readonly onSessionStartEnded?: GatewayHooks['onSessionStartEnded'];
  readonly onPromptStartRefused?: GatewayHooks['onPromptStartRefused'];
  readonly onStatus?: GatewayHooks['onStatus'];
  readonly onEvent?: GatewayHooks['onEvent'];
  readonly onAgentSession?: GatewayHooks['onAgentSession'];
  readonly onOptions?: GatewayHooks['onOptions'];
  readonly onOptionReceipt?: GatewayHooks['onOptionReceipt'];
  readonly agentConfig?: GatewayHooks['agentConfig'];
  readonly onTerminalData?: GatewayHooks['onTerminalData'];
  readonly onTerminalExit?: GatewayHooks['onTerminalExit'];
  readonly onWorkdirTerminalData?: GatewayHooks['onWorkdirTerminalData'];
  readonly onWorkdirTerminalExit?: GatewayHooks['onWorkdirTerminalExit'];
  readonly onWorkdirTerminalConnected?: GatewayHooks['onWorkdirTerminalConnected'];
  readonly knownTerminals?: GatewayHooks['knownTerminals'];
  readonly reply?: (method: string, params: unknown) => unknown;
  /** 网关选项：超时这类要用小值。 */
  readonly gateway?: GatewayOptions;
  /** 模拟 Worker 收到但不回复（聚合超时）。 */
  readonly drop?: (method: string) => boolean;
}

async function harness(options: HarnessOptions = {}) {
  let helloSeen = false;
  const gateway = createServerGateway({
    token: options.token ?? null,
    ...(options.localSecret ? { localSecret: options.localSecret } : {}),
    ...(options.authenticate ? { authenticate: options.authenticate } : {}),
    ...(options.onConnectionObservation ? { onConnectionObservation: options.onConnectionObservation } : {}),
    ...(options.onObservedRuntimeInstall ? { onObservedRuntimeInstall: options.onObservedRuntimeInstall } : {}),
    ...(options.onRuntimeJob ? { onRuntimeJob: options.onRuntimeJob } : {}),
    ...(options.onBranchAttemptResult ? { onBranchAttemptResult: options.onBranchAttemptResult } : {}),
    ...(options.onSessionStartChanged ? { onSessionStartChanged: options.onSessionStartChanged } : {}),
    ...(options.onSessionStartEnded ? { onSessionStartEnded: options.onSessionStartEnded } : {}),
    ...(options.onPromptStartRefused ? { onPromptStartRefused: options.onPromptStartRefused } : {}),
    ...(options.agentConfig ? { agentConfig: options.agentConfig } : {}),
    onHello: () => {
      helloSeen = true;
    },
    onEvent: options.onEvent ?? (() => {}),
    onAgentSession: options.onAgentSession ?? (() => {}),
    onOptions: options.onOptions ?? (() => {}),
    ...(options.onOptionReceipt ? { onOptionReceipt: options.onOptionReceipt } : {}),
    onStatus: options.onStatus ?? (() => {}),
    onWorkerGone: () => {},
    ...(options.onTerminalData ? { onTerminalData: options.onTerminalData } : {}),
    ...(options.onTerminalExit ? { onTerminalExit: options.onTerminalExit } : {}),
    ...(options.onWorkdirTerminalData ? { onWorkdirTerminalData: options.onWorkdirTerminalData } : {}),
    ...(options.onWorkdirTerminalExit ? { onWorkdirTerminalExit: options.onWorkdirTerminalExit } : {}),
    ...(options.onWorkdirTerminalConnected ? { onWorkdirTerminalConnected: options.onWorkdirTerminalConnected } : {}),
    ...(options.knownTerminals ? { knownTerminals: options.knownTerminals } : {})
  }, options.gateway ?? {});
  const server: Server = createServer();
  server.on('upgrade', (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const reply = options.reply ?? ((method: string, params: unknown) => {
    if (method === 'terminal.open') {
      const p = params as { cols: number; rows: number };
      return { cols: p.cols, rows: p.rows, reused: false };
    }
    if (method === 'terminal.list') return { terminals: [] };
    return { ok: true };
  });

  /** 冒充 worker 的裸 WebSocket：hello 之后所有 hub 发来的 rpc 立即回复。 */
  async function connect(workerId = 'w1', hello: Record<string, unknown> = {}): Promise<Wire> {
    const ws = new WebSocket(url);
    const calls: Call[] = [];
    const frames: ServerToWorker[] = [];
    ws.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as ServerToWorker & { frame?: { rpc: string; id: string; method: string; params: unknown } };
      if (frame.kind === 'rpc' && frame.frame?.rpc === 'call') {
        const { id, method, params } = frame.frame;
        calls.push({ method, params });
        if (options.drop?.(method)) return;
        const outcome = reply(method, params);
        ws.send(
          JSON.stringify({
            type: 'rpc',
            frame: 'error' in (outcome as object) ? { rpc: 'reply', id, error: (outcome as { error: unknown }).error } : { rpc: 'reply', id, result: outcome }
          })
        );
        return;
      }
      frames.push(frame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'hello', workerId, label: workerId, origin: 'remote', agents: [], roots: [], sessions: [], ...hello }));
    await until(() => helloSeen && frames.some((frame) => frame.kind === 'welcome'));
    return { ws, calls, frames };
  }

  const stop = async (...wires: Wire[]) => {
    for (const wire of wires) wire.ws.close();
    gateway.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { gateway, url, connect, stop };
}

test('workdir protocol is negotiated and isolated from legacy terminal frames and inventory', async () => {
  const epoch = randomUUID(), terminalId = `wdt_${randomUUID()}`;
  const workdirData: string[] = [], legacyData: string[] = [];
  const h = await harness({ gateway: { echoMs: 0 }, authenticate: async ({ workerId }) => ({ ok: true, via: 'credential', enrollment: { workerId, enrolledBy: 'test', createdAt: 1 } }), onWorkdirTerminalData: (_w, _e, id) => workdirData.push(id), onTerminalData: (_w, id) => legacyData.push(id), reply: (method) => method === 'workdir_terminal.v1.inventory' ? { epoch, terminals: [{ terminalId, workspaceId: 'w', state: 'running' }] } : method === 'terminal.list' ? { terminals: [] } : { ok: true } });
  const legacy = await h.connect('old');
  const modern = await h.connect('new', { capabilities: [WORKER_CAPABILITY_WORKDIR_TERMINAL_V1] });
  try {
    const oldResult = await h.gateway.workdirTerminals('old').inventory();
    assert.equal(oldResult.ok, false); if (!oldResult.ok) assert.equal(oldResult.code, 'unsupported');
    assert.equal(legacy.calls.some((call) => call.method.startsWith('workdir_terminal')), false);
    const inv = await h.gateway.workdirTerminals('new').inventory();
    assert.equal(inv.ok && inv.value.terminals[0]?.terminalId, terminalId);
    const oldInv = await h.gateway.listTerminals('new');
    assert.deepEqual(oldInv, { ok: true, value: [] });
    modern.ws.send(JSON.stringify({ type: 'workdir_terminal_data_v1', epoch, terminalId, data: 'eA==' }));
    modern.ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 'legacy', data: 'eA==' }));
    await until(() => workdirData.length === 1 && legacyData.length === 1);
    assert.deepEqual(workdirData, [terminalId]); assert.deepEqual(legacyData, ['legacy']);
    assert.equal(h.gateway.workdirTerminals('old').input({ epoch, terminalId, data: 'eA==' }), false);
    assert.equal(h.gateway.workdirTerminals('new').input({ epoch, terminalId, data: 'eA==' }), true);
    await until(() => modern.frames.some((frame) => frame.kind === 'workdir_terminal_input_v1'));
  } finally { await h.stop(legacy, modern); }
});

test('legacy open checks current negotiated capability; resize still works, memory survives disconnect', async () => {
  const h = await harness({ gateway: { echoMs: 0 } });
  const legacy = await h.connect('same'); let modern: Wire | undefined; let oldAgain: Wire | undefined;
  try {
    const input = { terminalId: 'legacy', sessionId: 's1', cols: 80, rows: 24 };
    assert.equal(h.gateway.workdirTerminalSupported('same'), false);
    assert.equal((await h.gateway.openTerminal('same', input)).ok, true);
    modern = await h.connect('same', { capabilities: [WORKER_CAPABILITY_WORKDIR_TERMINAL_V1] });
    assert.equal(h.gateway.workdirTerminalSupported('same'), true);
    assert.equal((await h.gateway.openTerminal('same', input)).ok, false);
    assert.equal(modern.calls.some((call) => call.method === 'terminal.open'), false);
    assert.equal((await h.gateway.resizeTerminal('same', 'legacy', 80, 24)).ok, true);
    modern.ws.close();
    await until(() => h.gateway.workers().find((w) => w.workerId === 'same')?.state === 'offline');
    assert.equal(h.gateway.workdirTerminalSupported('same'), true);
    oldAgain = await h.connect('same');
    assert.equal(h.gateway.workdirTerminalSupported('same'), false);
    assert.equal((await h.gateway.openTerminal('same', input)).ok, true);
  } finally { await h.stop(legacy, ...(modern ? [modern] : []), ...(oldAgain ? [oldAgain] : [])); }
});

test('fenced mutation results distinguish explicit completion from ambiguous failures and replacement', async () => {
  let code = 'operation_settled_unavailable';
  const h = await harness({ gateway: { echoMs: 0, requestTimeoutMs: 25 }, reply: () => ({ error: { code, message: 'failure' } }), drop: () => code === 'drop' });
  const w = await h.connect('w'); let newer: Wire | undefined;
  const clone = () => h.gateway.gateway.git('w').clone({ repoUrl: 'https://example.com/repo', parent: '/tmp', name: 'foo' });
  try {
    let outcome = await clone(); assert.equal(!outcome.ok && outcome.error.operationSettled, true);
    code = 'failed'; outcome = await clone(); assert.equal(!outcome.ok && outcome.error.operationSettled, undefined);
    code = 'bad_result'; outcome = await clone(); assert.equal(!outcome.ok && outcome.error.operationSettled, undefined);
    code = 'drop';
    const pending = clone(); await until(() => w.calls.length >= 4);
    newer = await h.connect('w'); outcome = await pending; assert.equal(!outcome.ok && outcome.error.operationSettled, undefined);
    newer.ws.close(); await until(() => h.gateway.workers().find((item) => item.workerId === 'w')?.state === 'offline');
    outcome = await clone(); assert.equal(!outcome.ok && outcome.error.operationSettled, true);
  } finally { await h.stop(w, ...(newer ? [newer] : [])); }
});

test('group remove preserves completed negative result and never marks ambiguous errors settled', async () => {
  let mode = 'negative';
  const h = await harness({ gateway: { echoMs: 0 }, reply: () => mode === 'negative' ? { removed: false } : { error: { code: mode, message: 'failure' } } });
  const w = await h.connect('w');
  try {
    const remove = () => h.gateway.groups('w').remove({ root: '/tmp/a', id: 'a' });
    assert.deepEqual(await remove(), { ok: true, value: { removed: false } });
    mode = 'operation_settled_conflict';
    const completed = await remove(); assert.equal(!completed.ok && completed.error.operationSettled, true);
    mode = 'failed';
    const ambiguous = await remove(); assert.equal(!ambiguous.ok && ambiguous.error.operationSettled, undefined);
  } finally { await h.stop(w); }
});

test('workspace mutation safety needs a uniquely authenticated live capable connection', async () => {
  const h = await harness({ gateway: { echoMs: 0 }, authenticate: async ({ workerId, credential }) => credential === 'bound'
    ? { ok: true, via: 'credential', enrollment: { workerId, enrolledBy: 'test', createdAt: 1 } }
    : { ok: true, via: 'shared' } });
  const shared = await h.connect('shared', { capabilities: [WORKER_CAPABILITY_WORKSPACE_MUTATION_SAFETY_V1] });
  const old = await h.connect('bound', { credential: 'bound' });
  let capable: Wire | undefined, replacement: Wire | undefined;
  try {
    assert.equal(h.gateway.workspaceMutationSafe('missing'), false);
    assert.equal(h.gateway.workspaceMutationSafe('shared'), false);
    assert.equal(h.gateway.workspaceMutationSafe('bound'), false);
    capable = await h.connect('bound', { credential: 'bound', capabilities: [WORKER_CAPABILITY_WORKSPACE_MUTATION_SAFETY_V1] });
    assert.equal(h.gateway.workspaceMutationSafe('bound'), true);
    replacement = await h.connect('bound', { credential: 'bound' });
    assert.equal(h.gateway.workspaceMutationSafe('bound'), false);
    replacement.ws.close();
    await until(() => h.gateway.workers().find((item) => item.workerId === 'bound')?.state === 'offline');
    assert.equal(h.gateway.workspaceMutationSafe('bound'), false);
  } finally { await h.stop(shared, old, ...(capable ? [capable] : []), ...(replacement ? [replacement] : [])); }
});

test('planned requests require authenticated connection and preserve explicit settlement', async () => {
  let mode = 'operation_settled_conflict';
  const h = await harness({ gateway: { echoMs: 0 }, authenticate: async ({ workerId, credential }) => credential === 'bound'
    ? { ok: true, via: 'credential', enrollment: { workerId, enrolledBy: 'test', createdAt: 1 } }
    : { ok: true, via: 'shared' }, reply: () => ({ error: { code: mode, message: 'settled' } }) });
  const shared = await h.connect('shared');
  const bound = await h.connect('bound', { credential: 'bound' });
  try {
    const input = { sourcePath: '/repo', startRef: null, expectedTopLevel: '/repo', expectedCommonDir: '/repo/.git', expectedIdentity: 'b'.repeat(64), expectedOid: 'a'.repeat(40), targetPath: '/managed/a', branch: 'branch', operationId: 'op' };
    const sharedResult = await h.gateway.gateway.git('shared').createPlannedWorktree!(input);
    assert.equal(!sharedResult.ok && sharedResult.error.operationSettled, true);
    assert.equal(shared.calls.some((call) => call.method === 'ws.create_planned_worktree'), false);
    const git = h.gateway.gateway.git('bound');
    const settled = await git.createPlannedWorktree!(input);
    assert.equal(!settled.ok && settled.error.operationSettled, true);
    const reconciliation = await git.createPlannedWorktree!({ ...input, reconcileOnly: true });
    assert.equal(!reconciliation.ok && reconciliation.error.operationSettled, undefined);
    mode = 'failed';
    const uncertain = await git.createPlannedWorktree!(input);
    assert.equal(!uncertain.ok && uncertain.error.operationSettled, undefined);
  } finally { await h.stop(shared, bound); }
});

test('planned probes and mutations discard results from replaced connections', async () => {
  const h = await harness({ gateway: { echoMs: 0, requestTimeoutMs: 30 }, authenticate: async ({ workerId }) =>
    ({ ok: true, via: 'credential', enrollment: { workerId, enrolledBy: 'test', createdAt: 1 } }), drop: () => true });
  const first = await h.connect('w'); let second: Wire | undefined; let third: Wire | undefined;
  try {
    const probe = h.gateway.gateway.git('w').inspectPlannedWorktree!({ sourcePath: '/repo', startRef: null });
    await until(() => first.calls.some((call) => call.method === 'ws.inspect_planned_worktree'));
    second = await h.connect('w');
    const observed = await probe;
    assert.equal(!observed.ok && observed.error.operationSettled, undefined);
    const mutation = h.gateway.gateway.git('w').createPlannedWorktree!({ sourcePath: '/repo', startRef: null, expectedTopLevel: '/repo', expectedCommonDir: '/repo/.git', expectedIdentity: 'b'.repeat(64), expectedOid: 'a'.repeat(40), targetPath: '/managed/a', branch: 'branch', operationId: 'op' });
    await until(() => second!.calls.some((call) => call.method === 'ws.create_planned_worktree'));
    third = await h.connect('w');
    const outcome = await mutation;
    assert.equal(!outcome.ok && outcome.error.operationSettled, undefined);
  } finally { await h.stop(first, ...(second ? [second] : []), ...(third ? [third] : [])); }
});

test('planned verify uses authenticated read request and forwards receipt attribution', async () => {
  const input = { sourcePath: '/repo', startRef: null, expectedTopLevel: '/repo', expectedCommonDir: '/repo/.git', expectedIdentity: 'b'.repeat(64), expectedOid: 'a'.repeat(40), targetPath: '/managed/a', branch: 'branch', operationId: 'op' };
  const outcome = { path: input.targetPath, branch: input.branch, oid: input.expectedOid, alreadyCreated: true };
  const h = await harness({ gateway: { echoMs: 0 }, authenticate: async ({ workerId, credential }) => credential === 'bound'
    ? { ok: true, via: 'credential', enrollment: { workerId, enrolledBy: 'test', createdAt: 1 } }
    : { ok: true, via: 'shared' }, reply: () => outcome });
  const shared = await h.connect('shared'); const bound = await h.connect('bound', { credential: 'bound' });
  try {
    assert.equal((await h.gateway.gateway.git('shared').verifyPlannedWorktree!(input)).ok, false);
    assert.equal(shared.calls.some(call => call.method === 'ws.verify_planned_worktree'), false);
    const result = await h.gateway.gateway.git('bound').verifyPlannedWorktree!(input);
    assert.equal(result.ok, true); if (result.ok) assert.deepEqual(result.value, outcome);
    assert.deepEqual(bound.calls.find(call => call.method === 'ws.verify_planned_worktree')?.params, input);
  } finally { await h.stop(shared, bound); }
});

test('required mutation safety checks current identity and capability at every dispatch; default remains compatible', async () => {
  const h = await harness({ gateway: { echoMs: 0, workspaceMutationSafetyRequired: true }, authenticate: async ({ workerId, credential }) => credential === 'bound'
    ? { ok: true, via: 'credential', enrollment: { workerId, enrolledBy: 'test', createdAt: 1 } }
    : { ok: true, via: 'shared' } });
  const capable = await h.connect('w', { credential: 'bound', capabilities: [WORKER_CAPABILITY_WORKSPACE_MUTATION_SAFETY_V1] });
  let legacy: Wire | undefined, unverified: Wire | undefined;
  try {
    assert.equal(h.gateway.workspaceMutationSafe('w'), true);
    legacy = await h.connect('w', { credential: 'bound' });
    const git = h.gateway.gateway.git('w'), groups = h.gateway.groups('w');
    const results = await Promise.all([
      git.clone({ repoUrl: 'https://example.com/a', parent: '/tmp', name: 'a' }),
      git.addWorktree({ repoPath: '/tmp/r', path: '/tmp/a', branch: 'a', existing: true }),
      git.remove('/tmp/a', 'worktree'),
      git.prepareDelegationWorktree!({ repoPath: '/tmp/r', path: '/tmp/a', branch: 'a', baseBranch: 'main', expectedUrl: 'https://example.com/a' }),
      groups.init({ slug: 's', name: 'n', id: 'i' }), groups.remove({ root: '/tmp/a', id: 'i' }),
      groups.newWorktree({ repoPath: '/tmp/r', path: '/tmp/a', branch: 'a' })
    ]);
    for (const result of results) assert.equal(!result.ok && result.error.operationSettled, true);
    assert.deepEqual(legacy.calls.filter((call) => ['ws.clone', 'ws.add_worktree', 'ws.remove', 'ws.prepare_delegation_worktree', 'ws.group_init', 'ws.group_remove', 'ws.new_worktree'].includes(call.method)), []);
    unverified = await h.connect('w', { capabilities: [WORKER_CAPABILITY_WORKSPACE_MUTATION_SAFETY_V1] });
    const refused = await git.clone({ repoUrl: 'https://example.com/a', parent: '/tmp', name: 'a' });
    assert.equal(!refused.ok && refused.error.operationSettled, true);
    assert.equal(unverified.calls.some((call) => call.method === 'ws.clone'), false);
  } finally { await h.stop(capable, ...(legacy ? [legacy] : []), ...(unverified ? [unverified] : [])); }

  const permissive = await harness({ gateway: { echoMs: 0 }, reply: () => ({ error: { code: 'failed', message: 'legacy' } }) });
  const old = await permissive.connect('old');
  try {
    const result = await permissive.gateway.gateway.git('old').clone({ repoUrl: 'https://example.com/a', parent: '/tmp', name: 'a' });
    assert.equal(!result.ok && result.error.operationSettled, undefined);
    assert.equal(old.calls.some((call) => call.method === 'ws.clone'), true);
  } finally { await permissive.stop(old); }
});

test('real Worker emits explicit completed errors for fenced git and group worktree', async () => {
  const h = await harness({ gateway: { echoMs: 0 }, authenticate: async ({ workerId }) => ({ ok: true, via: 'credential', enrollment: { workerId, enrolledBy: 'test', createdAt: 1 } }) });
  const files = createWorkerFiles({ roots: ['/tmp'], enforced: true });
  let accepted = false;
  const link = connectWorkerLink({ url: h.url, token: '', workerId: 'git-worker', label: 'real', reconnect: false, runtimes: [], sessionIdleMs: 0, welcomeFallbackMs: 50, files, groupsDir: '/tmp', onAccepted: () => { accepted = true; } });
  try {
    await until(() => accepted);
    assert.equal(h.gateway.workspaceMutationSafe('git-worker'), true);
    assert.equal(h.gateway.workdirTerminalSupported('git-worker'), false);
    const result = await h.gateway.gateway.git('git-worker').clone({ repoUrl: 'https://example.com/repo', parent: '/tmp', name: '../invalid' });
    assert.equal(!result.ok && result.error.operationSettled, true);
    const tree = await h.gateway.groups('git-worker').newWorktree({ repoPath: '/tmp', path: '/tmp/a', branch: ' ' });
    assert.equal(!tree.ok && tree.error.operationSettled, true);
    const groupRemove = await h.gateway.groups('git-worker').remove({ root: '/not-allowed', id: 'test' });
    assert.equal(!groupRemove.ok && groupRemove.error.operationSettled, true);
    const local = await createGitWorkspace().clone({ repoUrl: 'https://example.com/repo', parent: '/tmp', name: '../invalid' });
    assert.equal(!local.ok && local.error.operationSettled, true);
    const localTree = await createGroupWorktrees(async () => null, { groupsDir: '/tmp' }).newWorktree({ repoPath: '/tmp', path: '/tmp/a', branch: '' });
    assert.equal(!localTree.ok && localTree.error.operationSettled, true);
  } finally { await link.close(); await h.stop(); }
});

test('workdir RPC result is stale when worker connection is replaced', async () => {
  const h = await harness({ gateway: { echoMs: 0 }, authenticate: async ({ workerId }) => ({ ok: true, via: 'credential', enrollment: { workerId, enrolledBy: 'test', createdAt: 1 } }), drop: (method) => method === 'workdir_terminal.v1.inventory' });
  const old = await h.connect('w1', { capabilities: [WORKER_CAPABILITY_WORKDIR_TERMINAL_V1] });
  let next: Wire | undefined;
  try {
    const pending = h.gateway.workdirTerminals('w1').inventory();
    await until(() => old.calls.some((call) => call.method === 'workdir_terminal.v1.inventory'));
    next = await h.connect('w1', { capabilities: [WORKER_CAPABILITY_WORKDIR_TERMINAL_V1] });
    const result = await pending; assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, 'stale');
  } finally { await h.stop(old, ...(next ? [next] : [])); }
});

test('workdir requires a uniquely authenticated current worker, including incoming frames', async () => {
  const epoch = randomUUID(), terminalId = `wdt_${randomUUID()}`;
  const data: string[] = [], exits: string[] = [], connected: string[] = [], markers: string[] = [];
  const h = await harness({ gateway: { echoMs: 0 }, token: 'shared', localSecret: 'local-secret',
    authenticate: async ({ workerId, credential, sharedTokenOk }) => credential === 'bound'
      ? { ok: true, via: 'credential', enrollment: { workerId, enrolledBy: 'owner', createdAt: 1 } }
      : sharedTokenOk ? { ok: true, via: 'shared' } : { ok: false, reason: 'denied' },
    onWorkdirTerminalConnected: (workerId) => connected.push(workerId),
    onWorkdirTerminalData: (workerId) => data.push(workerId),
    onWorkdirTerminalExit: (workerId) => exits.push(workerId),
    onTerminalData: (workerId) => markers.push(workerId),
    reply: (method) => method === 'workdir_terminal.v1.inventory' ? { epoch, terminals: [] } : method === 'terminal.list' ? { terminals: [] } : { ok: true }
  });
  const hello = { capabilities: [WORKER_CAPABILITY_WORKDIR_TERMINAL_V1] };
  const shared = await h.connect('shared', { ...hello, origin: 'local', token: 'shared' });
  const enrolled = await h.connect('enrolled', { ...hello, credential: 'bound' });
  const local = await h.connect('local', { ...hello, origin: 'local', localSecret: 'local-secret', token: 'shared' });
  let replacement: Wire | undefined;
  const key = { epoch, terminalId };
  const incoming = (wire: Wire) => {
    wire.ws.send(JSON.stringify({ type: 'workdir_terminal_data_v1', ...key, data: 'eA==' }));
    wire.ws.send(JSON.stringify({ type: 'workdir_terminal_exit_v1', ...key, code: 0 }));
    wire.ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 'legacy', data: 'eA==' }));
  };
  try {
    await until(() => connected.length === 2);
    assert.deepEqual(connected.sort(), ['enrolled', 'local']);
    const sharedGateway = h.gateway.workdirTerminals('shared');
    for (const outcome of await Promise.all([
      sharedGateway.inventory(), sharedGateway.create({ ...key, workspaceId: 'w', cwd: '/tmp' }),
      sharedGateway.attach({ ...key, cols: 80, rows: 24 }), sharedGateway.resize({ ...key, cols: 80, rows: 24 }), sharedGateway.close(key)
    ])) { assert.equal(outcome.ok, false); if (!outcome.ok) assert.equal(outcome.code, 'unsupported'); }
    assert.equal(sharedGateway.input({ ...key, data: 'eA==' }), false);
    sharedGateway.detach(key);
    assert.equal(shared.calls.some((call) => call.method.startsWith('workdir_terminal')), false);
    assert.equal(shared.frames.some((frame) => frame.kind === 'workdir_terminal_input_v1' || frame.kind === 'workdir_terminal_detach_v1'), false);
    assert.equal((await h.gateway.workdirTerminals('enrolled').inventory()).ok, true);
    assert.equal((await h.gateway.workdirTerminals('local').inventory()).ok, true);
    incoming(shared); incoming(enrolled); incoming(local);
    await until(() => markers.length === 3);
    assert.deepEqual(data.sort(), ['enrolled', 'local']);
    assert.deepEqual(exits.sort(), ['enrolled', 'local']);
    replacement = await h.connect('enrolled', { ...hello, token: 'shared' });
    const result = await h.gateway.workdirTerminals('enrolled').inventory();
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, 'unsupported');
    incoming(replacement); await until(() => markers.length === 4);
    assert.equal(data.length, 2); assert.equal(exits.length, 2); assert.equal(connected.length, 2);
    assert.deepEqual(await h.gateway.listTerminals('shared'), { ok: true, value: [] });
  } finally { await h.stop(shared, enrolled, local, ...(replacement ? [replacement] : [])); }
});

test('real worker link hosts isolated workdir terminal RPC and input frames', async () => {
  const seen: string[] = [];
  const h = await harness({ gateway: { echoMs: 0 }, authenticate: async ({ workerId }) => ({ ok: true, via: 'credential', enrollment: { workerId, enrolledBy: 'test', createdAt: 1 } }), onWorkdirTerminalData: (_w, _e, _id, data) => seen.push(data) });
  let accepted = false;
  let link: ReturnType<typeof connectWorkerLink>;
  let output: (text: string) => void = () => {};
  let exit: (event: { exitCode: number }) => void = () => {};
  const writes: string[] = [];
  const host = createWorkdirTerminalHost({ shell: '/bin/sh', check: async () => null, backpressure: () => 0,
    onData: (epoch, id, data) => link.sendWorkdirTerminalData(epoch, id, data),
    onExit: (epoch, id, code) => link.sendWorkdirTerminalExit(epoch, id, code),
    pty: { spawn: () => ({ pid: 1, onData: (cb) => { output = cb; return { dispose() {} }; }, onExit: (cb) => { exit = cb; return { dispose() {} }; },
      write: (data) => { writes.push(data); }, resize() {}, pause() {}, resume() {}, kill() {} }) }
  })!;
  link = connectWorkerLink({ url: h.url, token: '', workerId: 'real-workdir', label: 'real', reconnect: false, runtimes: [], sessionIdleMs: 0, welcomeFallbackMs: 50, workdirTerminal: host, onAccepted: () => { accepted = true; } });
  try {
    await until(() => accepted);
    const gateway = h.gateway.workdirTerminals('real-workdir');
    const inventory = await gateway.inventory();
    assert.equal(inventory.ok, true);
    if (!inventory.ok) return;
    const key = { epoch: inventory.value.epoch, terminalId: `wdt_${randomUUID()}` };
    assert.deepEqual(await gateway.create({ ...key, cwd: await realpath('/tmp'), workspaceId: 'w' }), { ok: true, value: { state: 'running' } });
    assert.equal((await gateway.attach({ ...key, cols: 80, rows: 24 })).ok, true);
    assert.equal(gateway.input({ ...key, data: Buffer.from('hi').toString('base64') }), true);
    await until(() => writes.length === 1);
    assert.deepEqual(writes, ['hi']);
    output('hello');
    await until(() => seen.length === 1);
    assert.equal(Buffer.from(seen[0]!, 'base64').toString(), 'hello');
    assert.deepEqual(await gateway.close(key), { ok: true, value: { exited: false } });
    exit({ exitCode: 0 });
    assert.deepEqual(await gateway.create({ ...key, cwd: await realpath('/tmp'), workspaceId: 'w' }), { ok: true, value: { state: 'ended' } });
  } finally { await link.close(); await h.stop(); }
});

test('worker connection loss starts workdir linger; reconnect attach cancels it', async () => {
  const h = await harness({ gateway: { echoMs: 0 }, authenticate: async ({ workerId }) => ({ ok: true, via: 'credential', enrollment: { workerId, enrolledBy: 'test', createdAt: 1 } }) });
  let accepts = 0, detaches = 0, kills = 0;
  let exit: (event: { exitCode: number }) => void = () => {};
  const host = createWorkdirTerminalHost({ shell: '/bin/sh', check: async () => null, backpressure: () => 0,
    onData() {}, onExit() {}, lingerMs: 250,
    pty: { spawn: () => ({ pid: 1, onData: () => ({ dispose() {} }), onExit: (cb) => { exit = cb; return { dispose() {} }; },
      write() {}, resize() {}, pause() {}, resume() {}, kill() { kills++; } }) }
  })!;
  const workerHost = { ...host, detachAll() { detaches++; host.detachAll(); } };
  const link = connectWorkerLink({ url: h.url, token: '', workerId: 'reconnect-workdir', label: 'real', reconnect: true, initialBackoffMs: 10, maxBackoffMs: 10, runtimes: [], sessionIdleMs: 0, welcomeFallbackMs: 50, workdirTerminal: workerHost, onAccepted: () => { accepts++; } });
  const replacements: Wire[] = [];
  try {
    await until(() => accepts === 1);
    const gateway = h.gateway.workdirTerminals('reconnect-workdir');
    const key = { epoch: host.epoch, terminalId: `wdt_${randomUUID()}` };
    assert.equal((await gateway.create({ ...key, cwd: await realpath('/tmp'), workspaceId: 'w' })).ok, true);
    assert.equal((await gateway.attach({ ...key, cols: 80, rows: 24 })).ok, true);
    replacements.push(await h.connect('reconnect-workdir', { capabilities: [WORKER_CAPABILITY_WORKDIR_TERMINAL_V1] }));
    await until(() => detaches === 1 && accepts >= 2);
    assert.equal((await gateway.attach({ ...key, cols: 80, rows: 24 })).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(kills, 0);
    assert.equal((await host.inventory()).epoch, key.epoch);
    replacements.push(await h.connect('reconnect-workdir', { capabilities: [WORKER_CAPABILITY_WORKDIR_TERMINAL_V1] }));
    await until(() => detaches === 2 && accepts >= 3);
    await until(() => kills === 1);
    assert.equal((await host.inventory()).terminals[0]?.state, 'closing');
    exit({ exitCode: 0 });
  } finally { await link.close(); await h.stop(...replacements); }
});

test('option receipts require negotiated socket, key and current generation; old workers receive unkeyed commands', async () => {
  const received: string[] = [];
  const guards: (() => boolean)[] = [];
  const h = await harness({ onOptionReceipt: (_worker, _session, requestId, _option, _outcome, _options, current) => { assert.equal(current(), true); guards.push(current); received.push(requestId); }, gateway: { echoMs: 0 } });
  const wire = await h.connect('w1', { capabilities: [WORKER_CAPABILITY_OPTION_RECEIPT] });
  let old: Wire | undefined;
  try {
    h.gateway.adopt('w1', ['s']);
    const command = { kind: 'set_option' as const, sessionId: asSessionId('s'), optionId: 'effort', value: 'high', requestId: 'r1' };
    assert.equal((await h.gateway.gateway.dispatch(command)).ok, true);
    await until(() => wire.frames.some((frame) => frame.kind === 'set_option'));
    const send = (requestId: string, optionId = 'effort') => wire.ws.send(JSON.stringify({ type: 'option_receipt', sessionId: 's', requestId, optionId, outcome: 'unknown' }));
    send('wrong'); send('r1', 'other'); send('r1'); send('r1');
    await until(() => received.length === 1);
    assert.deepEqual(received, ['r1']);
    assert.equal((await h.gateway.gateway.dispatch({ ...command, requestId: 'r2' })).ok, true);
    assert.equal(guards[0]?.(), false, 'newer option dispatch invalidates even an accepted receipt');
    send('r2');
    await until(() => received.length === 2);
    assert.equal(guards[1]?.(), true);
    old = await h.connect('w1');
    h.gateway.adopt('w1', ['s']);
    assert.equal(guards[1]?.(), false, 'socket replacement invalidates accepted receipt');
    send('r2');
    assert.equal((await h.gateway.gateway.dispatch({ ...command, requestId: 'r3' })).ok, true);
    await until(() => old!.frames.some((frame) => frame.kind === 'set_option'));
    const legacy = old.frames.find((frame) => frame.kind === 'set_option');
    assert.equal(legacy?.kind === 'set_option' && legacy.requestId, undefined);
    assert.deepEqual(received, ['r1', 'r2']);
  } finally { await h.stop(wire, ...(old ? [old] : [])); }
});

test('first-prompt fork projects only worker origin for legacy compatibility', async () => {
  const h = await harness({ gateway: { echoMs: 0 } });
  const wire = await h.connect();
  try {
    const origin = { kind: 'fork' as const, fromSessionId: asSessionId('parent'), atSeq: 0 };
    const branch = { fromAgentSessionRef: 'parent-ref', turnRef: null, previousTurnRef: null };
    const command = { kind: 'start_session' as const, sessionId: asSessionId('zero'), workerId: 'w1', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin, resume: null, options: {}, branch };
    assert.equal((await h.gateway.gateway.dispatch(command)).ok, true);
    const positiveOrigin = { ...origin, atSeq: 7 };
    assert.equal((await h.gateway.gateway.dispatch({ ...command, sessionId: asSessionId('positive'), origin: positiveOrigin })).ok, true);
    await until(() => wire.frames.filter((frame) => frame.kind === 'start_session').length === 2);
    const frames = wire.frames.filter((frame) => frame.kind === 'start_session');
    assert.deepEqual(frames[0]?.origin, { kind: 'derive' });
    assert.deepEqual(frames[0]?.branch, branch);
    assert.equal(frames[0]?.resume, null);
    assert.deepEqual(origin, { kind: 'fork', fromSessionId: 'parent', atSeq: 0 });
    assert.deepEqual(frames[1]?.origin, positiveOrigin);
    assert.deepEqual(frames[1]?.branch, branch);
  } finally {
    await h.stop(wire);
  }
});

test('session start wire IDs are optional for old peers and bounded for new frames', () => {
  const prompt = { kind: 'prompt', sessionId: 's1', text: '', parts: [], deliveryId: 'd1' };
  const start = { kind: 'start_session', sessionId: 's1', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' }, resume: null, options: {} };
  assert.equal(serverToWorkerSchema.safeParse(start).success, true);
  assert.equal(serverToWorkerSchema.safeParse({ ...start, startAttemptId: 'a' }).success, true);
  assert.equal(serverToWorkerSchema.safeParse({ ...start, startAttemptId: '' }).success, false);
  assert.equal(serverToWorkerSchema.safeParse(prompt).success, true);
  assert.equal(serverToWorkerSchema.safeParse({ ...prompt, startAttemptId: 'x'.repeat(128) }).success, true);
  for (const startAttemptId of ['', 'x'.repeat(129)]) {
    assert.equal(serverToWorkerSchema.safeParse({ ...prompt, startAttemptId }).success, false);
    assert.equal(workerToServerSchema.safeParse({ type: 'session_start_result', sessionId: 's1', startAttemptId, state: 'ready' }).success, false);
  }
  assert.equal(workerToServerSchema.safeParse({ type: 'prompt_start_refused', sessionId: 's1', startAttemptId: 'a', deliveryId: 'd' }).success, true);
  assert.equal(workerToServerSchema.safeParse({ type: 'prompt_start_refused', sessionId: 's1', startAttemptId: 'a', deliveryId: '' }).success, false);
});

test('explicit start attempt is delivered exactly and fenced to its live connection', async () => {
  let markers = 0;
  const changes: string[] = [];
  const ends: Array<() => boolean> = [];
  const receipts: string[] = [];
  const h = await harness({ gateway: { echoMs: 0 }, onTerminalData: () => { markers++; }, onOptionReceipt: (_w, _s, id) => receipts.push(id), onSessionStartChanged: (_w, s) => changes.push(s), onSessionStartEnded: (_w, _s, _a, current) => ends.push(current) });
  const hello = { capabilities: [WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_DURABLE_DELIVERY, WORKER_CAPABILITY_OPTION_RECEIPT] };
  const first = await h.connect('w1', hello);
  const other = await h.connect('w2', hello);
  const old = await h.connect('old', { capabilities: [WORKER_CAPABILITY_SESSION_START_READY] });
  const sessionId = asSessionId('explicit-start');
  const start = { kind: 'start_session' as const, sessionId, workerId: 'w1', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' as const }, resume: null, options: {}, startAttemptId: 'durable-attempt' };
  const sync = async (wire: Wire) => { const target = markers + 1; wire.ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 'test', data: 'aGk=' })); await until(() => markers >= target); };
  try {
    assert.equal((await h.gateway.gateway.dispatch(start)).ok, true);
    await until(() => first.frames.some((f) => f.kind === 'start_session'));
    const sent = first.frames.find((f) => f.kind === 'start_session');
    assert.ok(sent?.kind === 'start_session');
    assert.equal(sent.startAttemptId, start.startAttemptId);
    assert.equal((await h.gateway.gateway.dispatch(start)).ok, false);
    assert.equal((await h.gateway.gateway.dispatch({ ...start, workerId: 'w2' })).ok, false);
    other.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: start.startAttemptId, state: 'ready' }));
    first.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: 'wrong', state: 'ready' }));
    await sync(other); await sync(first);
    assert.deepEqual(changes, []);
    assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1'), { state: 'starting' });
    first.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: start.startAttemptId, state: 'ready' }));
    await until(() => changes.length === 1);
    assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1'), { state: 'ready', startAttemptId: start.startAttemptId });
    assert.equal((await h.gateway.gateway.dispatch({ kind: 'set_option', sessionId, optionId: 'effort', value: 'high', requestId: 'option-1' })).ok, true);

    for (const rejected of [
      { ...start, startAttemptId: '' }, { ...start, startAttemptId: 'x'.repeat(129) },
      { ...start, workerId: 'offline', startAttemptId: 'new' },
      { ...start, workerId: 'old', startAttemptId: 'new' }
    ]) {
      const result = await h.gateway.gateway.dispatch(rejected);
      assert.equal(result.ok, false);
      assert.match(!result.ok ? result.error.message : '', /not sent/);
      assert.equal(h.gateway.hostOf(sessionId), 'w1');
      assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1'), { state: 'ready', startAttemptId: start.startAttemptId });
    }
    await sync(old);
    assert.equal(old.frames.some((f) => f.kind === 'start_session'), false);
    assert.equal(other.frames.some((f) => f.kind === 'start_session'), false);
    assert.equal(first.frames.filter((f) => f.kind === 'start_session').length, 1);
    first.ws.send(JSON.stringify({ type: 'option_receipt', sessionId, requestId: 'option-1', optionId: 'effort', outcome: 'unknown' }));
    await until(() => receipts.length === 1);
    first.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: start.startAttemptId, state: 'ended' }));
    await until(() => ends.length === 1);
    assert.equal((await h.gateway.gateway.dispatch(start)).ok, false);
    assert.equal(ends[0]!(), true);
    await sync(first);
    assert.equal(first.frames.filter((f) => f.kind === 'start_session').length, 1);
  } finally { await h.stop(first, other, old); }
});

test('start connection identity rejects a replaced socket and is never sent on the wire', async () => {
  const h = await harness({ gateway: { echoMs: 0 } });
  const hello = { capabilities: [WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_DURABLE_DELIVERY, WORKER_CAPABILITY_SESSION_START_NATIVE_REF] };
  const first = await h.connect('w1', hello);
  let replacement: Wire | undefined;
  const sessionId = asSessionId('socket-fenced');
  const start = { kind: 'start_session' as const, sessionId, workerId: 'w1', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' as const }, resume: null, options: {}, startAttemptId: 'socket-attempt' };
  try {
    const oldId = h.gateway.gateway.sessionStartConnection!('w1');
    assert.ok(oldId);
    assert.equal(h.gateway.gateway.sessionStartConnection!('missing'), null);
    replacement = await h.connect('w1', hello);
    const currentId = h.gateway.gateway.sessionStartConnection!('w1');
    assert.ok(currentId);
    assert.notEqual(currentId, oldId);
    h.gateway.adopt('w1', [sessionId]);
    const rejected = await h.gateway.gateway.dispatch({ ...start, expectedStartConnectionId: oldId });
    assert.equal(rejected.ok, false);
    assert.match(!rejected.ok ? rejected.error.message : '', /not sent/);
    assert.equal(h.gateway.hostOf(sessionId), 'w1');
    assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1'), { state: 'untracked' });
    assert.equal((await h.gateway.gateway.dispatch({ ...start, expectedStartConnectionId: currentId })).ok, true);
    await until(() => replacement!.frames.some((f) => f.kind === 'start_session'));
    const frame = replacement.frames.find((f) => f.kind === 'start_session');
    assert.ok(frame?.kind === 'start_session');
    assert.equal(frame.startAttemptId, start.startAttemptId);
    assert.equal('expectedStartConnectionId' in frame, false);
    assert.equal(first.frames.some((f) => f.kind === 'start_session'), false);
    assert.equal(replacement.frames.filter((f) => f.kind === 'start_session').length, 1);
  } finally { await h.stop(first, ...(replacement ? [replacement] : [])); }
});

test('start connection identity requires all three capabilities and sessions permission', async () => {
  const h = await harness({ gateway: { echoMs: 0 }, authenticate: async ({ workerId }) => ({ ok: true, capabilities: workerId === 'denied' ? ['files.read'] : ['sessions'] }) });
  const hello = { capabilities: [WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_DURABLE_DELIVERY, WORKER_CAPABILITY_SESSION_START_NATIVE_REF] };
  const denied = await h.connect('denied', hello);
  const partial = await h.connect('partial', { capabilities: [WORKER_CAPABILITY_SESSION_START_READY] });
  const capable = await h.connect('capable', hello);
  try {
    assert.equal(h.gateway.gateway.sessionStartConnection!('denied'), null);
    assert.equal(h.gateway.gateway.sessionStartConnection!('partial'), null);
    const id = h.gateway.gateway.sessionStartConnection!('capable');
    assert.ok(id);
    const result = await h.gateway.gateway.dispatch({ kind: 'start_session', sessionId: asSessionId('missing-attempt'), workerId: 'capable', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' }, resume: null, options: {}, expectedStartConnectionId: id });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error.message : '', /not sent/);
    assert.equal(capable.frames.some((f) => f.kind === 'start_session'), false);
  } finally { await h.stop(denied, partial, capable); }
});

test('native handoff catalog projects only exact agent proof on an eligible live worker connection', async () => {
  const h = await harness({ gateway: { echoMs: 0 }, authenticate: async ({ workerId }) => ({ ok: true, capabilities: workerId === 'denied' ? ['files.read'] : ['sessions'] }) });
  const descriptor = { id: asAgentId('native'), label: 'Native', capabilities: capabilityMatrix(Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, available])) as Record<CapabilityName, Capability>), models: ['m'], defaultModel: 'm', options: [], nativeHandoff: true as const };
  const dto = agentToDto(descriptor);
  assert.equal(agentFromDto(agentSchema.parse(dto)).nativeHandoff, true);
  assert.equal(agentFromDto(agentSchema.parse({ ...dto, nativeHandoff: undefined })).nativeHandoff, undefined);
  assert.equal(agentSchema.safeParse({ ...dto, nativeHandoff: false }).success, false);
  const agents = [dto, { ...dto, id: 'plain', nativeHandoff: undefined }];
  const all = [WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_DURABLE_DELIVERY, WORKER_CAPABILITY_SESSION_START_NATIVE_REF];
  const current = await h.connect('current', { capabilities: all, agents });
  const old = await h.connect('old', { capabilities: all.slice(0, 2), agents });
  const noReady = await h.connect('no-ready', { capabilities: all.slice(1), agents });
  const noDurable = await h.connect('no-durable', { capabilities: [all[0], all[2]], agents });
  const denied = await h.connect('denied', { capabilities: all, agents });
  let replacement: Wire | undefined;
  let restored: Wire | undefined;
  const status = (workerId: string) => h.gateway.workers().find((worker) => worker.workerId === workerId)!;
  const proof = (workerId: string, agentId: string) => status(workerId).agentModels?.find((agent) => agent.agentId === agentId)?.nativeHandoff;
  try {
    assert.equal(proof('current', 'native'), true);
    assert.equal(proof('current', 'plain'), undefined);
    for (const id of ['old', 'no-ready', 'no-durable', 'denied']) assert.equal(proof(id, 'native'), undefined, id);
    assert.deepEqual(status('current').capabilities, ['sessions']);
    const parsed = workerInfoSchema.parse({ ...status('current'), versionStatus: 'unknown', actions: { update: false, updateLogs: false, disconnect: false, rotateCredential: false, revokeCredential: false, installRuntime: false, installComponent: false, configureResources: false } });
    assert.equal(parsed.agentModels?.[0]?.nativeHandoff, true);
    replacement = await h.connect('current', { capabilities: all.slice(0, 2), agents });
    assert.equal(proof('current', 'native'), undefined);
    old.ws.close();
    await until(() => status('old').state === 'offline');
    assert.equal(proof('old', 'native'), undefined);
    restored = await h.connect('current', { capabilities: all, agents });
    assert.equal(proof('current', 'native'), true);
    restored.ws.close();
    await until(() => status('current').state === 'offline');
    assert.equal(proof('current', 'native'), undefined);
  } finally { await h.stop(current, old, noReady, noDurable, denied, ...(replacement ? [replacement] : []), ...(restored ? [restored] : [])); }
});

test('old readiness-capable worker refuses handoff pre-I/O but ordinary managed starts and options remain available', async () => {
  const receipts: string[] = [];
  let markers = 0;
  const h = await harness({ gateway: { echoMs: 0 }, onOptionReceipt: (_w, _s, id) => receipts.push(id), onTerminalData: () => { markers++; } });
  const hello = { capabilities: [WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_DURABLE_DELIVERY, WORKER_CAPABILITY_OPTION_RECEIPT] };
  const old = await h.connect('old', hello);
  const current = await h.connect('current', { capabilities: [...hello.capabilities, WORKER_CAPABILITY_SESSION_START_NATIVE_REF] });
  const sessionId = asSessionId('mixed-fleet');
  const command = { kind: 'start_session' as const, sessionId, workerId: 'old', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' as const }, resume: null, options: {} };
  const sync = async (wire: Wire) => { const target = markers + 1; wire.ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 'sync', data: 'aGk=' })); await until(() => markers >= target); };
  try {
    assert.equal(h.gateway.gateway.sessionStartConnection!('old'), null);
    const wrongConnectionId = h.gateway.gateway.sessionStartConnection!('current');
    assert.ok(wrongConnectionId);
    assert.equal((await h.gateway.gateway.dispatch(command)).ok, true);
    await until(() => old.frames.some((frame) => frame.kind === 'start_session'));
    const sent = old.frames.find((frame) => frame.kind === 'start_session');
    assert.ok(sent?.kind === 'start_session' && sent.startAttemptId);
    old.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: sent.startAttemptId, state: 'ready' }));
    await until(() => h.gateway.gateway.sessionStartReadiness!(sessionId, 'old').state === 'ready');
    const readiness = h.gateway.gateway.sessionStartReadiness!(sessionId, 'old');
    assert.equal((await h.gateway.gateway.dispatch({ kind: 'set_option', sessionId, optionId: 'model', value: 'high', requestId: 'pending-option' })).ok, true);
    await until(() => old.frames.some((frame) => frame.kind === 'set_option'));
    const count = old.frames.length;
    const rejected = await h.gateway.gateway.dispatch({ ...command, startAttemptId: 'handoff', expectedStartConnectionId: wrongConnectionId });
    assert.equal(rejected.ok, false);
    assert.match(!rejected.ok ? rejected.error.message : '', /native ref proof; command not sent/);
    assert.equal(h.gateway.hostOf(sessionId), 'old');
    assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'old'), readiness);
    await sync(old);
    assert.equal(old.frames.length, count);
    assert.equal(current.frames.some((frame) => frame.kind === 'start_session'), false);
    old.ws.send(JSON.stringify({ type: 'option_receipt', sessionId, requestId: 'pending-option', optionId: 'model', outcome: 'unknown' }));
    await until(() => receipts.length === 1);
    assert.deepEqual(receipts, ['pending-option']);
    // Explicit generation without a handoff socket fence keeps previous behavior.
    assert.equal((await h.gateway.gateway.dispatch({ ...command, startAttemptId: 'ordinary-explicit' })).ok, true);
    await until(() => old.frames.filter((frame) => frame.kind === 'start_session').length === 2);
  } finally { await h.stop(old, current); }
});

test('keyed ready proof is accepted only for current attempt and socket, and never inferred from unkeyed frames', async () => {
  const reports: Array<Parameters<NonNullable<GatewayHooks['onSessionStartChanged']>>[2]> = [];
  const unkeyed: Array<Parameters<GatewayHooks['onOptions']>[3]> = [];
  let markers = 0;
  const h = await harness({ gateway: { echoMs: 0 }, onSessionStartChanged: (_w, _s, metadata) => reports.push(metadata), onOptions: (_w, _s, _o, metadata) => unkeyed.push(metadata), onTerminalData: () => { markers++; } });
  const hello = { capabilities: [WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_DURABLE_DELIVERY, WORKER_CAPABILITY_SESSION_START_NATIVE_REF] };
  const first = await h.connect('w1', hello);
  const other = await h.connect('w2', hello);
  let replacement: Wire | undefined;
  const sessionId = asSessionId('ready-proof');
  const start = { kind: 'start_session' as const, sessionId, workerId: 'w1', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' as const }, resume: null, options: {}, startAttemptId: 'a' };
  const option = { id: 'model', label: 'Model', category: 'model', kind: 'select', current: 'one', choices: [] };
  const send = (wire: Wire, frame: object) => wire.ws.send(JSON.stringify(frame));
  const sync = async (wire: Wire) => { const target = markers + 1; send(wire, { type: 'terminal_data', terminalId: 'sync', data: 'aGk=' }); await until(() => markers >= target); };
  try {
    assert.equal((await h.gateway.gateway.dispatch({ ...start, expectedStartConnectionId: h.gateway.gateway.sessionStartConnection!('w1')! })).ok, true);
    const proof = { type: 'session_start_result', sessionId, startAttemptId: 'a', state: 'ready', agentSessionRef: 'native-a', options: [option] };
    send(other, proof);
    send(first, { ...proof, startAttemptId: 'wrong' });
    send(first, { ...proof, agentSessionRef: 'pending' });
    send(first, { type: 'options', sessionId, options: [option] });
    await sync(other); await sync(first);
    assert.equal(reports.length, 0);
    assert.equal(unkeyed[0]?.ready, undefined);
    send(first, proof);
    await until(() => reports.length === 1);
    assert.deepEqual(reports[0]?.ready, { agentSessionRef: 'native-a', options: [option] });
    assert.equal(reports[0]?.isCurrent(), true);
    assert.equal((await h.gateway.gateway.dispatch({ ...start, startAttemptId: 'b' })).ok, true);
    assert.equal(reports[0]?.isCurrent(), false);
    send(first, proof);
    await sync(first);
    assert.equal(reports.length, 1);
    send(first, { ...proof, startAttemptId: 'b', agentSessionRef: 'native-b' });
    await until(() => reports.length === 2);
    assert.equal(reports[1]?.ready?.agentSessionRef, 'native-b');
    replacement = await h.connect('w1', hello);
    assert.equal(reports[1]?.isCurrent(), false);
    assert.equal((await h.gateway.gateway.dispatch({ ...start, startAttemptId: 'c', expectedStartConnectionId: h.gateway.gateway.sessionStartConnection!('w1')! })).ok, true);
    send(replacement, { ...proof, startAttemptId: 'b' });
    await sync(replacement);
    assert.equal(reports.length, 2);
    send(replacement, { type: 'session_start_result', sessionId, startAttemptId: 'c', state: 'ready' });
    await until(() => reports.length === 3);
    assert.deepEqual(reports[2]?.ready, {}, 'legacy worker has unknown proof');
    send(replacement, { type: 'session_start_result', sessionId, startAttemptId: 'c', state: 'ended', agentSessionRef: 'bad' });
    await until(() => reports.length === 4);
    assert.equal(reports[3], undefined);
    send(replacement, { ...proof, startAttemptId: 'c' });
    await sync(replacement);
    assert.equal(reports.length, 4);
  } finally { await h.stop(first, other, ...(replacement ? [replacement] : [])); }
});

test('real negotiated worker reports exact runtime proof for fresh, reused and replaced starts', async () => {
  const reports: Array<Parameters<NonNullable<GatewayHooks['onSessionStartChanged']>>[2]> = [];
  const h = await harness({ gateway: { echoMs: 0 }, onSessionStartChanged: (_w, _s, metadata) => { if (metadata?.ready) reports.push(metadata); } });
  const capabilities = Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, available])) as Record<CapabilityName, Capability>;
  let count = 0;
  const runtime: AgentRuntime = {
    descriptor: { id: asAgentId('echo'), label: 'Echo', capabilities: capabilityMatrix(capabilities), models: [], defaultModel: '', options: [] },
    async start(spec) {
      const number = ++count;
      const queue = new AsyncQueue<SessionEvent>();
      return { ok: true, value: {
        sessionId: spec.sessionId, nativeSessionRef: () => `native-${number}`,
        options: () => [{ id: 'model', label: 'Model', category: 'model', kind: 'select', current: `m-${number}`, choices: [] }],
        async prompt() { return { ok: true, value: undefined }; }, async interrupt() {}, events: () => queue,
        async adopt() {}, async changeOption() { return { ok: true, value: [] }; }, async dispose() { queue.close(); }
      } };
    }
  };
  let accepted = false;
  const link = connectWorkerLink({ url: h.url, token: '', workerId: 'real', label: 'real', reconnect: false, runtimes: [runtime], sessionIdleMs: 0, welcomeFallbackMs: 50, onAccepted: () => { accepted = true; } });
  const sessionId = asSessionId('real-proof');
  const command = { kind: 'start_session' as const, sessionId, workerId: 'real', taskId: null, agentId: 'echo', workspaceRoot: '/one', origin: { kind: 'derive' as const }, resume: null, options: {} };
  try {
    await until(() => accepted && h.gateway.gateway.sessionStartConnection!('real') !== null);
    const connectionId = h.gateway.gateway.sessionStartConnection!('real')!;
    for (const [attempt, root] of [['a', '/one'], ['b', '/one'], ['c', '/two']] as const) {
      assert.equal((await h.gateway.gateway.dispatch({ ...command, workspaceRoot: root, startAttemptId: attempt, expectedStartConnectionId: connectionId })).ok, true);
      await until(() => reports.some((report) => report?.attemptId === attempt)).catch(() => { throw new Error(`attempt ${attempt}: ${JSON.stringify(h.gateway.gateway.sessionStartReadiness!(sessionId, 'real'))}; starts=${count}; reports=${reports.length}`); });
    }
    assert.deepEqual(reports.map((r) => [r?.attemptId, r?.connectionId, r?.ready?.agentSessionRef, r?.ready?.options?.[0]?.current]), [
      ['a', connectionId, 'native-1', 'm-1'], ['b', connectionId, 'native-1', 'm-1'], ['c', connectionId, 'native-2', 'm-2']
    ]);
    assert.deepEqual(reports.map((r) => r?.isCurrent()), [false, false, true]);
    assert.equal(count, 2);
  } finally { await link.close(); await h.stop(); }
});

test('session callbacks carry current connection and generation metadata with revocable guards', async () => {
  const observed: Array<{ kind: string; metadata: Parameters<GatewayHooks['onEvent']>[3] }> = [];
  let markers = 0;
  const h = await harness({
    gateway: { echoMs: 0 }, onTerminalData: () => { markers++; },
    onEvent: (_w, _s, _event, metadata) => observed.push({ kind: 'event', metadata }),
    onAgentSession: (_w, _s, _ref, metadata) => observed.push({ kind: 'agent', metadata }),
    onOptions: (_w, _s, _options, metadata) => observed.push({ kind: 'options', metadata }),
    onStatus: (_w, _s, _status, _reason, metadata) => observed.push({ kind: 'status', metadata }),
    onSessionStartChanged: (_w, _s, metadata) => observed.push({ kind: 'changed', metadata })
  });
  const hello = { capabilities: [WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_DURABLE_DELIVERY, WORKER_CAPABILITY_SESSION_START_NATIVE_REF] };
  const first = await h.connect('w1', hello);
  const other = await h.connect('w2', hello);
  let replacement: Wire | undefined;
  const sessionId = asSessionId('provenance');
  const start = { kind: 'start_session' as const, sessionId, workerId: 'w1', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' as const }, resume: null, options: {}, startAttemptId: 'generation-1' };
  const send = (w: Wire, frame: object) => w.ws.send(JSON.stringify(frame));
  const sync = async (w: Wire) => { const target = markers + 1; send(w, { type: 'terminal_data', terminalId: 'test', data: 'aGk=' }); await until(() => markers >= target); };
  try {
    const connectionId = h.gateway.gateway.sessionStartConnection!('w1');
    assert.ok(connectionId);
    assert.equal((await h.gateway.gateway.dispatch(start)).ok, true);
    send(first, { type: 'agent_session', sessionId, agentSessionRef: 'ref' });
    send(first, { type: 'options', sessionId, options: [] });
    send(first, { type: 'event', sessionId, event: { kind: 'ended', outcome: 'done' } });
    send(first, { type: 'status', sessionId, status: 'idle' });
    send(first, { type: 'session_start_result', sessionId, startAttemptId: start.startAttemptId, state: 'ready' });
    await until(() => observed.length === 5);
    assert.deepEqual(observed.map((item) => item.kind), ['agent', 'options', 'event', 'status', 'changed']);
    for (const { metadata } of observed) {
      assert.equal(metadata?.attemptId, start.startAttemptId);
      assert.equal(metadata?.connectionId, connectionId);
      assert.equal(metadata?.isCurrent(), true);
    }
    send(other, { type: 'agent_session', sessionId, agentSessionRef: 'other' });
    await sync(other);
    assert.equal(observed.at(-1)?.metadata, undefined);
    const old = observed[0]!.metadata!;
    assert.equal((await h.gateway.gateway.dispatch({ ...start, startAttemptId: 'generation-2' })).ok, true);
    assert.equal(old.isCurrent(), false);
    send(first, { type: 'options', sessionId, options: [] });
    await until(() => observed.at(-1)?.metadata?.attemptId === 'generation-2');
    const second = observed.at(-1)!.metadata!;
    replacement = await h.connect('w1', hello);
    assert.equal(second.isCurrent(), false);
    send(replacement, { type: 'options', sessionId, options: [] });
    await sync(replacement);
    assert.equal(observed.at(-1)?.metadata, undefined);
    assert.equal((await h.gateway.gateway.dispatch({ ...start, startAttemptId: 'generation-3' })).ok, true);
    send(replacement, { type: 'session_start_result', sessionId, startAttemptId: 'generation-3', state: 'ended' });
    await sync(replacement);
    assert.equal(observed.at(-1)?.kind, 'changed');
    assert.equal(observed.at(-1)?.metadata, undefined);
    send(replacement, { type: 'event', sessionId, event: { kind: 'ended', outcome: 'done' } });
    await sync(replacement);
    assert.equal(observed.at(-1)?.kind, 'event');
    assert.equal(observed.at(-1)?.metadata, undefined);
  } finally { await h.stop(first, other, ...(replacement ? [replacement] : [])); }
});

test('keyed prompts are fenced by current start generation and refusals are exactly correlated', async () => {
  let clock = 0;
  let markers = 0;
  const changes: unknown[][] = [];
  const refusals: unknown[][] = [];
  const statuses: unknown[][] = [];
  const ends: Array<{ worker: string; session: string; attempt: string; isCurrent: () => boolean }> = [];
  const h = await harness({ gateway: { echoMs: 0, now: () => clock, sessionStartTimeoutMs: 10 }, onSessionStartChanged: (...a) => changes.push(a), onSessionStartEnded: (worker, session, attempt, isCurrent) => ends.push({ worker, session, attempt, isCurrent }), onPromptStartRefused: (...a) => refusals.push(a), onStatus: (...a) => statuses.push(a), onTerminalData: () => { markers++; } });
  const hello = { capabilities: [WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_DURABLE_DELIVERY] };
  const first = await h.connect('w1', hello);
  const other = await h.connect('w2', hello);
  const sessionId = asSessionId('ready-session');
  const start = { kind: 'start_session' as const, sessionId, workerId: 'w1', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' as const }, resume: null, options: {} };
  const prompt = { kind: 'prompt' as const, sessionId, text: 'hello', parts: [], deliveryId: 'd1' };
  const sync = async (wire: Wire) => { const target = markers + 1; wire.ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 'test', data: 'aGk=' })); await until(() => markers >= target); };
  try {
    assert.equal((await h.gateway.gateway.dispatch(start)).ok, true);
    await until(() => first.frames.some((f) => f.kind === 'start_session'));
    const sent = first.frames.find((f) => f.kind === 'start_session');
    assert.ok(sent?.kind === 'start_session' && sent.startAttemptId);
    const attempt = sent.startAttemptId;
    assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1'), { state: 'starting' });
    const pending = await h.gateway.gateway.dispatch({ ...prompt, startAttemptId: attempt });
    assert.equal(pending.ok, false);
    assert.equal(!pending.ok && pending.error.deliveryDeferred, true);
    other.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: attempt, state: 'ready' }));
    first.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: 'stale', state: 'ready' }));
    await sync(first);
    assert.equal(changes.length, 0);
    clock = 11;
    assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1'), { state: 'failed', reason: 'timed_out' });
    first.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: attempt, state: 'ready' }));
    await until(() => changes.length === 1);
    assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1'), { state: 'ready', startAttemptId: attempt });
    assert.equal((await h.gateway.gateway.dispatch({ ...prompt, startAttemptId: 'stale' })).ok, false);
    assert.equal((await h.gateway.gateway.dispatch({ ...prompt, startAttemptId: attempt })).ok, true);
    await until(() => first.frames.some((f) => f.kind === 'prompt'));
    other.ws.send(JSON.stringify({ type: 'prompt_start_refused', sessionId, startAttemptId: attempt, deliveryId: 'd1' }));
    first.ws.send(JSON.stringify({ type: 'prompt_start_refused', sessionId, startAttemptId: attempt, deliveryId: 'arbitrary' }));
    first.ws.send(JSON.stringify({ type: 'prompt_start_refused', sessionId, startAttemptId: attempt, deliveryId: 'd1' }));
    first.ws.send(JSON.stringify({ type: 'prompt_start_refused', sessionId, startAttemptId: attempt, deliveryId: 'd1' }));
    await sync(first);
    assert.deepEqual(refusals, [['w1', sessionId, 'd1']]);
    assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1'), { state: 'failed', reason: 'runtime' });
    assert.equal((await h.gateway.gateway.dispatch(start)).ok, true);
    await until(() => first.frames.filter((f) => f.kind === 'start_session').length === 2);
    const second = first.frames.filter((f) => f.kind === 'start_session')[1]!;
    assert.ok(second.kind === 'start_session' && second.startAttemptId && second.startAttemptId !== attempt);
    first.ws.send(JSON.stringify({ type: 'status', sessionId, status: 'ended' }));
    first.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: attempt, state: 'ended' }));
    await sync(first);
    assert.equal(statuses.length, 0);
    assert.equal(h.gateway.hostOf(sessionId), 'w1');
    first.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: second.startAttemptId, state: 'failed', reason: 'configuration' }));
    await until(() => changes.length === 3);
    assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1'), { state: 'failed', reason: 'configuration' });
    h.gateway.gateway.retrySessionStart!(sessionId, 'w1');
    first.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: second.startAttemptId, state: 'ready' }));
    await sync(first);
    assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1'), { state: 'untracked' });
    assert.equal((await h.gateway.gateway.dispatch(start)).ok, true);
    await until(() => first.frames.filter((f) => f.kind === 'start_session').length === 3);
    const third = first.frames.filter((f) => f.kind === 'start_session')[2]!;
    assert.ok(third.kind === 'start_session' && third.startAttemptId);
    first.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: third.startAttemptId, state: 'ended' }));
    await until(() => ends.length === 1);
    assert.equal(h.gateway.hostOf(sessionId), null);
    assert.equal(statuses.length, 0);
    assert.deepEqual({ ...ends[0], isCurrent: undefined }, { worker: 'w1', session: sessionId, attempt: third.startAttemptId, isCurrent: undefined });
    assert.equal(ends[0]!.isCurrent(), true);
    assert.equal((await h.gateway.gateway.dispatch(start)).ok, true);
    assert.equal(ends[0]!.isCurrent(), false);
  } finally { await h.stop(first, other); }
});

test('reconnect and old worker invalidate a pre-send readiness snapshot', async () => {
  const h = await harness({ gateway: { echoMs: 0 } });
  const hello = { capabilities: [WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_DURABLE_DELIVERY] };
  const first = await h.connect('w1', hello);
  const sessionId = asSessionId('reconnect');
  const start = { kind: 'start_session' as const, sessionId, workerId: 'w1', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' as const }, resume: null, options: {} };
  const prompt = { kind: 'prompt' as const, sessionId, text: 'hello', parts: [], deliveryId: 'd1' };
  try {
    assert.equal((await h.gateway.gateway.dispatch(start)).ok, true);
    await until(() => first.frames.some((f) => f.kind === 'start_session'));
    const frame = first.frames.find((f) => f.kind === 'start_session');
    assert.ok(frame?.kind === 'start_session' && frame.startAttemptId);
    first.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: frame.startAttemptId, state: 'ready' }));
    await until(() => h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1').state === 'ready');
    const replacement = await h.connect('w1', { capabilities: [WORKER_CAPABILITY_DURABLE_DELIVERY], sessions: [sessionId] });
    try {
      assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1'), { state: 'upgrade_required' });
      const result = await h.gateway.gateway.dispatch({ ...prompt, startAttemptId: frame.startAttemptId });
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.error.deliveryDeferred, true);
      assert.equal(replacement.frames.some((f) => f.kind === 'prompt'), false);
    } finally { await h.stop(replacement); }
  } finally { first.ws.close(); }
});

test('partial readiness capabilities require upgrade before a keyed delivery can be claimed', async () => {
  const h = await harness({ gateway: { echoMs: 0 } });
  const partial = await h.connect('partial', { capabilities: [WORKER_CAPABILITY_SESSION_START_READY] });
  const sessionId = asSessionId('partial');
  try {
    assert.equal((await h.gateway.gateway.dispatch({ kind: 'start_session', sessionId, workerId: 'partial', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' }, resume: null, options: {} })).ok, true);
    await until(() => partial.frames.some((frame) => frame.kind === 'start_session'));
    assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'partial'), { state: 'upgrade_required' });
    const sent = partial.frames.find((frame) => frame.kind === 'start_session');
    assert.ok(sent?.kind === 'start_session' && !sent.startAttemptId);
    const result = await h.gateway.gateway.dispatch({ kind: 'prompt', sessionId, text: 'hi', parts: [], deliveryId: 'd', startAttemptId: 'stale' });
    assert.equal(!result.ok && result.error.deliveryDeferred, true);
    assert.equal(partial.frames.some((frame) => frame.kind === 'prompt'), false);
  } finally { await h.stop(partial); }
});

test('pre-send keyed capability denial is explicitly deferred without sending', async () => {
  const h = await harness({ gateway: { echoMs: 0 }, authenticate: async () => ({ ok: true, capabilities: ['files.read'] }) });
  const wire = await h.connect('w1', { credential: 'c1', capabilities: [WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_DURABLE_DELIVERY] });
  const sessionId = asSessionId('denied');
  try {
    h.gateway.adopt('w1', [sessionId]);
    const result = await h.gateway.gateway.dispatch({ kind: 'prompt', sessionId, text: 'hello', parts: [], deliveryId: 'd', startAttemptId: 'attempt' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'forbidden');
      assert.equal(result.error.deliveryDeferred, true);
    }
    assert.equal(wire.frames.some((frame) => frame.kind === 'prompt'), false);
  } finally { await h.stop(wire); }
});

test('clean end retains exact refusal proof across same-socket replacement but not replay or reconnect', async () => {
  let markers = 0;
  const refusals: string[] = [];
  const guards: Array<() => boolean> = [];
  const h = await harness({ gateway: { echoMs: 0 }, onPromptStartRefused: (_worker, _session, deliveryId) => refusals.push(deliveryId), onSessionStartEnded: (_worker, _session, _attempt, isCurrent) => guards.push(isCurrent), onTerminalData: () => { markers++; } });
  const hello = { capabilities: [WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_DURABLE_DELIVERY] };
  const wire = await h.connect('w1', hello);
  const other = await h.connect('w2', hello);
  const sessionId = asSessionId('retired');
  const command = { kind: 'start_session' as const, sessionId, workerId: 'w1', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' as const }, resume: null, options: {} };
  const sync = async (w: Wire) => { const target = markers + 1; w.ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 'test', data: 'aGk=' })); await until(() => markers >= target); };
  const refuse = (w: Wire, attempt: string, deliveryId: string) => w.ws.send(JSON.stringify({ type: 'prompt_start_refused', sessionId, startAttemptId: attempt, deliveryId }));
  let replacement: Wire | undefined;
  try {
    await h.gateway.gateway.dispatch(command);
    await until(() => wire.frames.filter((f) => f.kind === 'start_session').length === 1);
    const first = wire.frames.find((f) => f.kind === 'start_session');
    assert.ok(first?.kind === 'start_session' && first.startAttemptId);
    const attempt = first.startAttemptId;
    wire.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: attempt, state: 'ready' }));
    await until(() => h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1').state === 'ready');
    const prompt = (deliveryId: string, startAttemptId: string) => h.gateway.gateway.dispatch({ kind: 'prompt', sessionId, text: 'hello', parts: [], deliveryId, startAttemptId });
    for (const id of ['delayed', 'reused', 'disconnected', 'duplicate']) assert.equal((await prompt(id, attempt)).ok, true);
    assert.equal((await prompt('duplicate', attempt)).ok, true);
    wire.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: attempt, state: 'ended' }));
    await until(() => guards.length === 1);
    assert.equal(guards[0]!(), true);
    assert.deepEqual(refusals, []);
    await h.gateway.gateway.dispatch(command);
    assert.equal(guards[0]!(), false);
    await until(() => wire.frames.filter((f) => f.kind === 'start_session').length === 2);
    const second = wire.frames.filter((f) => f.kind === 'start_session')[1];
    assert.ok(second?.kind === 'start_session' && second.startAttemptId);
    wire.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: second.startAttemptId, state: 'ready' }));
    await until(() => h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1').state === 'ready');
    assert.equal((await prompt('reused', second.startAttemptId)).ok, true);
    refuse(other, attempt, 'delayed');
    refuse(wire, 'wrong', 'delayed');
    refuse(wire, attempt, 'duplicate');
    refuse(wire, attempt, 'reused');
    refuse(wire, attempt, 'delayed');
    refuse(wire, attempt, 'delayed');
    await sync(wire);
    assert.deepEqual(refusals, ['delayed']);
    assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1'), { state: 'ready', startAttemptId: second.startAttemptId });
    replacement = await h.connect('w1', hello);
    refuse(replacement, attempt, 'disconnected');
    await sync(replacement);
    assert.deepEqual(refusals, ['delayed']);
  } finally { await h.stop(wire, other, ...(replacement ? [replacement] : [])); }
});

test('replacement and dispose retire outstanding exact refusal proof without an end receipt', async () => {
  const refusals: string[] = [];
  const h = await harness({ gateway: { echoMs: 0 }, onPromptStartRefused: (_worker, _session, id) => refusals.push(id) });
  const wire = await h.connect('w1', { capabilities: [WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_DURABLE_DELIVERY] });
  const sessionId = asSessionId('replace-retire');
  const start = { kind: 'start_session' as const, sessionId, workerId: 'w1', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' as const }, resume: null, options: {} };
  let previousAttempt = '';
  try {
    for (let i = 0; i < 2; i++) {
      assert.equal((await h.gateway.gateway.dispatch(start)).ok, true);
      await until(() => wire.frames.filter((f) => f.kind === 'start_session').length === i + 1);
      const frame = wire.frames.filter((f) => f.kind === 'start_session')[i];
      assert.ok(frame?.kind === 'start_session' && frame.startAttemptId);
      const attempt = frame.startAttemptId;
      wire.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: attempt, state: 'ready' }));
      await until(() => h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1').state === 'ready');
      assert.equal((await h.gateway.gateway.dispatch({ kind: 'prompt', sessionId, text: 'hi', parts: [], deliveryId: `d${i}`, startAttemptId: attempt })).ok, true);
      if (i === 0) {
        // The next iteration replaces the generation before the refusal arrives.
        previousAttempt = attempt;
      } else {
        await h.gateway.gateway.dispatch({ kind: 'dispose', sessionId });
        wire.ws.send(JSON.stringify({ type: 'prompt_start_refused', sessionId, startAttemptId: previousAttempt, deliveryId: 'd0' }));
        wire.ws.send(JSON.stringify({ type: 'prompt_start_refused', sessionId, startAttemptId: attempt, deliveryId: 'd1' }));
      }
    }
    await until(() => refusals.length === 2);
    assert.deepEqual(refusals, ['d0', 'd1']);
  } finally { await h.stop(wire); }
});

test('exact turn completion frees refusal capacity without making completed IDs replayable', async () => {
  let markers = 0;
  const refusals: string[] = [];
  const h = await harness({ gateway: { echoMs: 0 }, onPromptStartRefused: (_worker, _session, id) => refusals.push(id), onTerminalData: () => { markers++; } });
  const hello = { capabilities: [WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_DURABLE_DELIVERY] };
  const wire = await h.connect('w1', hello);
  const other = await h.connect('w2', hello);
  const sessionId = asSessionId('long-stream');
  try {
    await h.gateway.gateway.dispatch({ kind: 'start_session', sessionId, workerId: 'w1', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' }, resume: null, options: {} });
    await until(() => wire.frames.some((f) => f.kind === 'start_session'));
    const start = wire.frames.find((f) => f.kind === 'start_session');
    assert.ok(start?.kind === 'start_session' && start.startAttemptId);
    const attempt = start.startAttemptId;
    wire.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: attempt, state: 'ready' }));
    await until(() => h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1').state === 'ready');
    const prompt = (deliveryId: string) => h.gateway.gateway.dispatch({ kind: 'prompt', sessionId, text: 'hi', parts: [], deliveryId, startAttemptId: attempt });
    const event = (w: Wire, sid: string, id: string) => w.ws.send(JSON.stringify({ type: 'event', sessionId: sid, event: { kind: 'ended', outcome: 'done', deliveryId: id } }));
    const sync = async () => { const target = markers + 1; wire.ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 'test', data: 'aGk=' })); await until(() => markers === target); };
    for (let i = 0; i < 1100; i++) {
      assert.equal((await prompt(`d${i}`)).ok, true);
      event(wire, sessionId, `d${i}`);
      // Allow the socket to process completed turns before dispatching more.
      if (i % 100 === 99) await sync();
    }
    assert.equal((await prompt('d0')).ok, true);
    assert.equal((await prompt('fresh')).ok, true);
    assert.equal((await prompt('mismatch')).ok, true);
    event(other, sessionId, 'mismatch');
    event(wire, 'wrong-session', 'mismatch');
    wire.ws.send(JSON.stringify({ type: 'prompt_start_refused', sessionId, startAttemptId: attempt, deliveryId: 'd0' }));
    wire.ws.send(JSON.stringify({ type: 'prompt_start_refused', sessionId, startAttemptId: attempt, deliveryId: 'fresh' }));
    wire.ws.send(JSON.stringify({ type: 'prompt_start_refused', sessionId, startAttemptId: attempt, deliveryId: 'mismatch' }));
    await sync();
    assert.deepEqual(refusals, ['fresh', 'mismatch']);
  } finally { await h.stop(wire, other); }
});

test('end callback guard expires on dispose, retry, adoption, reconnect and gateway close', async () => {
  const guards = new Map<string, () => boolean>();
  const h = await harness({ gateway: { echoMs: 0 }, onSessionStartEnded: (_worker, session, _attempt, isCurrent) => guards.set(session, isCurrent) });
  const hello = { capabilities: [WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_DURABLE_DELIVERY] };
  const first = await h.connect('w1', hello);
  async function end(id: string, wire: Wire) {
    const sessionId = asSessionId(id);
    assert.equal((await h.gateway.gateway.dispatch({ kind: 'start_session', sessionId, workerId: 'w1', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' }, resume: null, options: {} })).ok, true);
    await until(() => wire.frames.some((f) => f.kind === 'start_session' && f.sessionId === id));
    const frame = wire.frames.find((f) => f.kind === 'start_session' && f.sessionId === id);
    assert.ok(frame?.kind === 'start_session' && frame.startAttemptId);
    wire.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: frame.startAttemptId, state: 'ended' }));
    await until(() => guards.has(id));
    assert.equal(guards.get(id)!(), true);
    return sessionId;
  }
  let replacement: Wire | undefined;
  try {
    const dispose = await end('dispose-end', first);
    await h.gateway.gateway.dispatch({ kind: 'dispose', sessionId: dispose });
    assert.equal(guards.get(dispose)!(), false);
    const retry = await end('retry-end', first);
    h.gateway.gateway.retrySessionStart!(retry, 'w1');
    assert.equal(guards.get(retry)!(), false);
    const adopt = await end('adopt-end', first);
    h.gateway.adopt('w1', [adopt]);
    assert.equal(guards.get(adopt)!(), false);
    const reconnect = await end('reconnect-end', first);
    replacement = await h.connect('w1', hello);
    assert.equal(guards.get(reconnect)!(), false);
    const disconnected = await end('disconnect-end', replacement);
    assert.equal(h.gateway.disconnect('w1'), true);
    assert.equal(guards.get(disconnected)!(), false);
    replacement.ws.close();
    replacement = await h.connect('w1', hello);
    const closed = await end('close-end', replacement);
    h.gateway.close();
    assert.equal(guards.get(closed)!(), false);
  } finally { await h.stop(first, ...(replacement ? [replacement] : [])); }
});

test('refusal evidence is bounded and never admits duplicate or overflow IDs', async () => {
  let markers = 0;
  const refusals: string[] = [];
  const h = await harness({ gateway: { echoMs: 0 }, onPromptStartRefused: (_worker, _session, deliveryId) => refusals.push(deliveryId), onTerminalData: () => { markers++; } });
  const wire = await h.connect('w1', { capabilities: [WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_DURABLE_DELIVERY] });
  const sessionId = asSessionId('proof-cap');
  try {
    await h.gateway.gateway.dispatch({ kind: 'start_session', sessionId, workerId: 'w1', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' }, resume: null, options: {} });
    await until(() => wire.frames.some((f) => f.kind === 'start_session'));
    const start = wire.frames.find((f) => f.kind === 'start_session');
    assert.ok(start?.kind === 'start_session' && start.startAttemptId);
    const startAttemptId = start.startAttemptId;
    wire.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId, state: 'ready' }));
    await until(() => h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1').state === 'ready');
    const dispatch = (deliveryId: string) => h.gateway.gateway.dispatch({ kind: 'prompt', sessionId, text: 'hi', parts: [], deliveryId, startAttemptId });
    for (let i = 0; i <= 1024; i++) assert.equal((await dispatch(`d${i}`)).ok, true);
    const refuse = (deliveryId: string) => wire.ws.send(JSON.stringify({ type: 'prompt_start_refused', sessionId, startAttemptId, deliveryId }));
    refuse('d0'); refuse('d1024');
    wire.ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 'test', data: 'aGk=' }));
    await until(() => markers === 1);
    assert.deepEqual(refusals, ['d0']);
    assert.equal((await dispatch('d0')).ok, false);
    assert.equal((await dispatch('d1024')).ok, false);
    refuse('d0'); refuse('d1024');
    wire.ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 'test', data: 'aGk=' }));
    await until(() => markers === 2);
    assert.deepEqual(refusals, ['d0']);
  } finally { await h.stop(wire); }
});

test('exact refusals stop automatic resend and explicit retries produce fresh generations', async () => {
  let markers = 0;
  const refusals: string[] = [];
  const changes: string[] = [];
  const h = await harness({ gateway: { echoMs: 0 }, onPromptStartRefused: (_worker, _session, id) => refusals.push(id), onSessionStartChanged: (_worker, session) => changes.push(session), onTerminalData: () => { markers++; } });
  const wire = await h.connect('w1', { capabilities: [WORKER_CAPABILITY_SESSION_START_READY, WORKER_CAPABILITY_DURABLE_DELIVERY] });
  const sessionId = asSessionId('repeat-refusal');
  const start = { kind: 'start_session' as const, sessionId, workerId: 'w1', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' as const }, resume: null, options: {} };
  const attempts: string[] = [];
  const sync = async () => { const target = markers + 1; wire.ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 'test', data: 'aGk=' })); await until(() => markers === target); };
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal((await h.gateway.gateway.dispatch(start)).ok, true);
      await until(() => wire.frames.filter((f) => f.kind === 'start_session').length === i + 1);
      const frame = wire.frames.filter((f) => f.kind === 'start_session')[i];
      assert.ok(frame?.kind === 'start_session' && frame.startAttemptId && !attempts.includes(frame.startAttemptId));
      const attempt = frame.startAttemptId;
      attempts.push(attempt);
      wire.ws.send(JSON.stringify({ type: 'session_start_result', sessionId, startAttemptId: attempt, state: 'ready' }));
      await until(() => h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1').state === 'ready');
      if (i > 0) {
        wire.ws.send(JSON.stringify({ type: 'prompt_start_refused', sessionId, startAttemptId: attempts[i - 1], deliveryId: 'd' }));
        await sync();
        assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1'), { state: 'ready', startAttemptId: attempt });
        assert.equal(refusals.length, i);
      }
      if (i === 2) break;
      const prompt = { kind: 'prompt' as const, sessionId, text: 'hi', parts: [], deliveryId: 'd', startAttemptId: attempt };
      assert.equal((await h.gateway.gateway.dispatch(prompt)).ok, true);
      wire.ws.send(JSON.stringify({ type: 'prompt_start_refused', sessionId, startAttemptId: attempt, deliveryId: 'd' }));
      await until(() => refusals.length === i + 1);
      assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1'), { state: 'failed', reason: 'runtime' });
      const retry = await h.gateway.gateway.dispatch(prompt);
      assert.equal(!retry.ok && retry.error.deliveryDeferred, true);
      h.gateway.gateway.retrySessionStart!(sessionId, 'w1');
      assert.deepEqual(h.gateway.gateway.sessionStartReadiness!(sessionId, 'w1'), { state: 'untracked' });
    }
    assert.deepEqual(refusals, ['d', 'd']);
    assert.equal(changes.length, 5);
  } finally { await h.stop(wire); }
});

test('keyed branch transport requires current socket capability and correlates results to sent attempts', async () => {
  const results: unknown[][] = [];
  const h = await harness({ onBranchAttemptResult: (...args) => results.push(args), gateway: { echoMs: 0 } });
  const old = await h.connect('w1');
  const command = { kind: 'start_session' as const, sessionId: asSessionId('s1'), workerId: 'w1', taskId: null, agentId: 'echo', workspaceRoot: '/tmp', origin: { kind: 'derive' as const }, resume: null, options: {}, branch: { fromAgentSessionRef: 'parent', turnRef: null, previousTurnRef: null }, branchAttemptId: 'attempt-1' };
  const agent = { id: 'echo', label: 'Echo', capabilities: Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, available])), models: [], defaultModel: '', options: [] };
  const hello = { capabilities: [WORKER_CAPABILITY_BRANCH_ATTEMPT], branchAttemptAgents: ['echo'], agents: [agent] };
  assert.equal(h.gateway.supportsBranchAttempt('w1', 'echo'), false);
  assert.equal((await h.gateway.gateway.dispatch(command)).ok, false);
  assert.equal(old.frames.some((f) => f.kind === 'start_session'), false);
  const current = await h.connect('w1', hello);
  assert.equal(h.gateway.supportsBranchAttempt('w1', 'echo'), true);
  assert.equal(h.gateway.supportsBranchAttempt('w1', 'other'), false);
  assert.equal((await h.gateway.gateway.dispatch({ ...command, agentId: 'other' })).ok, false);
  const { branch: _branch, ...withoutBranch } = command;
  assert.equal((await h.gateway.gateway.dispatch(withoutBranch)).ok, false);
  assert.equal((await h.gateway.gateway.dispatch(command)).ok, true);
  await until(() => current.frames.some((f) => f.kind === 'start_session'));
  const sent = current.frames.find((f) => f.kind === 'start_session');
  assert.equal(sent?.kind === 'start_session' && sent.branchAttemptId, 'attempt-1');
  current.ws.send(JSON.stringify({ type: 'branch_attempt_result', sessionId: 's1', attemptId: 'wrong', outcome: 'native', agentSessionRef: 'ref' }));
  current.ws.send(JSON.stringify({ type: 'branch_attempt_result', sessionId: 's1', attemptId: 'attempt-1', outcome: 'native', agentSessionRef: 'pending' }));
  current.ws.send(JSON.stringify({ type: 'branch_attempt_result', sessionId: 's1', attemptId: 'attempt-1', outcome: 'native', agentSessionRef: 'parent' }));
  current.ws.send(JSON.stringify({ type: 'branch_attempt_result', sessionId: 's1', attemptId: 'attempt-1', outcome: 'plain', agentSessionRef: 'parent' }));
  current.ws.send(JSON.stringify({ type: 'branch_attempt_result', sessionId: 's1', attemptId: 'attempt-1', outcome: 'native', agentSessionRef: 'ref' }));
  await until(() => results.length === 1);
  assert.deepEqual(results, [['w1', 's1', 'attempt-1', 'native', 'ref']]);
  current.ws.send(JSON.stringify({ type: 'branch_attempt_result', sessionId: 's1', attemptId: 'attempt-1', outcome: 'native', agentSessionRef: 'ref' }));
  const replacement = await h.connect('w1', hello);
  replacement.ws.send(JSON.stringify({ type: 'branch_attempt_result', sessionId: 's1', attemptId: 'attempt-1', outcome: 'native', agentSessionRef: 'ref' }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(results.length, 1);
  await h.stop(old, current, replacement);
});

test('connection observations bind authenticated identities and close replacement before new connection', async () => {
  const observations: WorkerConnectionObservation[] = [];
  let repeatedProcessed = false;
  const { connect, stop, gateway } = await harness({
    authenticate: async ({ workerId, credential }) => credential === 'synthetic-credential'
      ? { ok: true, via: 'credential', enrollment: { workerId, enrolledBy: 'synthetic-user', createdAt: 123 } }
      : { ok: false, reason: 'rejected' },
    onConnectionObservation: (observation) => observations.push(observation),
    onTerminalData: () => { repeatedProcessed = true; },
    gateway: { now: () => 456, echoMs: 0 }
  });
  const first = await connect('remote-test', { credential: 'synthetic-credential' });
  first.ws.send(JSON.stringify({ type: 'hello', workerId: 'remote-test', label: 'repeat', origin: 'remote', agents: [], roots: [], sessions: [], credential: 'synthetic-credential' }));
  first.ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 'test', data: 'aGk=' }));
  await until(() => repeatedProcessed);
  assert.equal(first.frames.filter((frame) => frame.kind === 'welcome').length, 1);
  assert.equal(observations.length, 1);
  const second = await connect('remote-test', { credential: 'synthetic-credential' });
  await until(() => observations.length === 3);
  assert.deepEqual(observations.map((o) => o.kind), ['connected', 'disconnected', 'connected']);
  assert.deepEqual(observations[0], { connectionId: observations[0]!.connectionId, workerId: 'remote-test', origin: 'remote', enrollment: { enrolledBy: 'synthetic-user', createdAt: 123 }, kind: 'connected', at: 456 });
  assert.equal(observations[0]!.connectionId, observations[1]!.connectionId);
  assert.notEqual(observations[0]!.connectionId, observations[2]!.connectionId);
  assert.equal(gateway.workers().find((worker) => worker.workerId === 'remote-test')?.state, 'online');
  second.ws.close();
  await until(() => observations.length === 4);
  assert.equal(observations[3]!.connectionId, observations[2]!.connectionId);
  assert.equal(observations[3]!.kind, 'disconnected');
  await stop(first, second);
});

test('a socket keeps its first authenticated identity and observation snapshot across queued hellos', async () => {
  const observations: WorkerConnectionObservation[] = [];
  const authCalls: string[] = [];
  let authenticated!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { authenticated = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let marker = false;
  const h = await harness({
    authenticate: async ({ workerId, credential }) => {
      authCalls.push(workerId);
      authenticated();
      await waiting;
      return credential === 'synthetic-one'
        ? { ok: true, via: 'credential', enrollment: { workerId, enrolledBy: 'synthetic-owner', createdAt: 7 } }
        : { ok: false, reason: 'rejected' };
    },
    onConnectionObservation: (o) => {
      observations.push(structuredClone(o));
      // Even a misbehaving observer cannot mutate the captured binding.
      if (o.enrollment) (o.enrollment as { enrolledBy: string }).enrolledBy = 'changed';
    },
    onTerminalData: () => { marker = true; },
    gateway: { echoMs: 0, now: () => 99 }
  });
  const ws = new WebSocket(h.url);
  await new Promise<void>((resolve) => ws.once('open', resolve));
  const hello = { type: 'hello', workerId: 'synthetic-first', label: 'first', origin: 'remote', agents: [], roots: [], sessions: [], credential: 'synthetic-one' };
  ws.send(JSON.stringify(hello));
  await entered;
  ws.send(JSON.stringify(hello));
  ws.send(JSON.stringify({ ...hello, workerId: 'synthetic-second', origin: 'local', credential: 'synthetic-two' }));
  ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 'test', data: 'aGk=' }));
  release();
  await until(() => marker);
  assert.deepEqual(authCalls, ['synthetic-first']);
  assert.deepEqual(h.gateway.workers().map(({ workerId, origin, state }) => ({ workerId, origin, state })), [{ workerId: 'synthetic-first', origin: 'remote', state: 'online' }]);
  assert.equal(observations.length, 1);
  const first = observations[0]!;
  assert.deepEqual(first, { connectionId: first.connectionId, workerId: 'synthetic-first', origin: 'remote', enrollment: { enrolledBy: 'synthetic-owner', createdAt: 7 }, kind: 'connected', at: 99 });
  ws.close();
  await until(() => observations.length === 2);
  assert.deepEqual(observations[1], { ...first, kind: 'disconnected' });
  await h.stop();
  assert.equal(observations.length, 2);
});

test('connection observations exclude shared, unauthenticated, mismatched and rejected workers', async () => {
  const observations: WorkerConnectionObservation[] = [];
  const h = await harness({
    token: 'synthetic-token',
    authenticate: async ({ workerId }) => workerId === 'rejected'
      ? { ok: false, reason: 'rejected' }
      : workerId === 'mismatch'
        ? { ok: true, via: 'credential', enrollment: { workerId: 'different', enrolledBy: 'u', createdAt: 1 } }
        : { ok: true, via: 'shared' },
    onConnectionObservation: (o) => observations.push(o)
  });
  const shared = await h.connect('shared', { token: 'synthetic-token' });
  const mismatch = await h.connect('mismatch', { credential: 'synthetic-credential' });
  const rejected = new WebSocket(h.url);
  await new Promise<void>((resolve) => rejected.once('open', resolve));
  const closed = new Promise<void>((resolve) => rejected.once('close', () => resolve()));
  rejected.send(JSON.stringify({ type: 'hello', workerId: 'rejected', label: 'rejected', origin: 'remote', agents: [], roots: [], sessions: [] }));
  await closed;
  shared.ws.close();
  mismatch.ws.close();
  await h.stop(shared, mismatch);
  assert.equal(observations.length, 0);
  const bare = await harness({ onConnectionObservation: (o) => observations.push(o) });
  const unauthenticated = await bare.connect('bare');
  await bare.stop(unauthenticated);
  assert.equal(observations.length, 0);
});

test('local observation precedes asynchronous aliases and observer exceptions do not affect connection', async () => {
  const observations: WorkerConnectionObservation[] = [];
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const h = await harness({
    localSecret: 'synthetic-local-secret',
    agentConfig: async () => { await waiting; return null; },
    onConnectionObservation: (o) => { observations.push(o); throw new Error('synthetic observer failure'); }
  });
  const connecting = h.connect('local-test', { origin: 'local', localSecret: 'synthetic-local-secret' });
  await until(() => observations.length === 1);
  assert.equal(observations[0]!.origin, 'local');
  assert.equal(observations[0]!.enrollment, null);
  release();
  const wire = await connecting;
  assert.equal(h.gateway.workers()[0]?.state, 'online');
  wire.ws.close();
  await until(() => observations.length === 2);
  assert.equal(observations[1]!.connectionId, observations[0]!.connectionId);
  await h.stop(wire);
});

const syntheticInstall = (jobId: string, action: RuntimeJob['action'] = 'install'): RuntimeJob => ({
  jobId, agentId: 'private-agent-name', action, version: '1.2.3', state: 'running',
  message: 'private config', log: 'private log', startedAt: 1, endedAt: null, actorEmail: 'private@example.test'
});

test('install observations require the exact dispatched job and explicit terminal state, and consume once', async () => {
  const observations: NonNullable<Parameters<NonNullable<GatewayHooks['onObservedRuntimeInstall']>>[0]>[] = [];
  const connections: WorkerConnectionObservation[] = [];
  const completed: RuntimeJob[] = [];
  let markers = 0;
  const h = await harness({
    authenticate: async ({ workerId }) => ({ ok: true, via: 'credential', enrollment: { workerId, enrolledBy: 'synthetic-owner', createdAt: 7 } }),
    onConnectionObservation: (o) => connections.push(o),
    onObservedRuntimeInstall: (o) => { observations.push(o); throw new Error('observer failure'); },
    onRuntimeJob: (_workerId, job) => completed.push(job),
    onTerminalData: () => { markers++; },
    gateway: { now: () => 99, echoMs: 0 }
  });
  const wire = await h.connect('synthetic-worker');
  const send = (jobId: string, state: string) => wire.ws.send(JSON.stringify({ type: 'runtime_job_status', jobId, state, message: 'private error', lines: ['private output'], version: 'private version' }));
  const sync = async () => { const target = markers + 1; wire.ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 'test', data: 'aGk=' })); await until(() => markers === target); };
  assert.equal(h.gateway.requestRuntimeJob('synthetic-worker', syntheticInstall('job-1')), true);
  send('old-job', 'succeeded');
  send('job-1', 'running');
  send('job-1', 'unknown');
  wire.ws.send(JSON.stringify({ type: 'update_status', state: 'failed', message: 'private', logTail: 'private' }));
  await sync();
  assert.equal(observations.length, 0);
  send('job-1', 'succeeded');
  send('job-1', 'failed');
  await sync();
  assert.deepEqual(observations, [{ connectionId: connections[0]!.connectionId, workerId: 'synthetic-worker', origin: 'remote', enrollment: { enrolledBy: 'synthetic-owner', createdAt: 7 }, action: 'install', state: 'succeeded', at: 99 }]);
  assert.equal(completed.length, 2); // Existing runtime-job callback is unchanged, including duplicate terminal frames.
  assert.equal(h.gateway.requestRuntimeJob('synthetic-worker', syntheticInstall('job-2', 'uninstall')), true);
  send('job-2', 'succeeded');
  await sync();
  assert.equal(observations.length, 1);
  await h.stop(wire);
});

test('install observations do not follow jobs to another connection or include unauthenticated connections', async () => {
  const observed: NonNullable<Parameters<NonNullable<GatewayHooks['onObservedRuntimeInstall']>>[0]>[] = [];
  let markers = 0;
  const h = await harness({
    authenticate: async ({ workerId }) => workerId === 'shared'
      ? { ok: true, via: 'shared' }
      : { ok: true, via: 'credential', enrollment: { workerId, enrolledBy: 'synthetic-owner', createdAt: 1 } },
    onObservedRuntimeInstall: (o) => observed.push(o),
    onTerminalData: () => { markers++; },
    gateway: { echoMs: 0 }
  });
  const first = await h.connect('synthetic-worker');
  assert.equal(h.gateway.requestRuntimeJob('synthetic-worker', syntheticInstall('job-1')), true);
  const replacement = await h.connect('synthetic-worker');
  replacement.ws.send(JSON.stringify({ type: 'runtime_job_status', jobId: 'job-1', state: 'failed', message: 'private', lines: [] }));
  replacement.ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 'test', data: 'aGk=' }));
  await until(() => markers === 1);
  assert.equal(observed.length, 0);
  const shared = await h.connect('shared');
  assert.equal(h.gateway.requestRuntimeJob('shared', syntheticInstall('job-2')), true);
  shared.ws.send(JSON.stringify({ type: 'runtime_job_status', jobId: 'job-2', state: 'refused', message: 'private', lines: [] }));
  shared.ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 'test', data: 'aGk=' }));
  await until(() => markers === 2);
  assert.equal(observed.length, 0);
  assert.equal(h.gateway.requestRuntimeJob('absent', syntheticInstall('job-3')), false);
  await h.stop(first, replacement, shared);
  assert.equal(observed.length, 0);

  const bare = await harness({ onObservedRuntimeInstall: (o) => observed.push(o), gateway: { echoMs: 0 } });
  const unauthenticated = await bare.connect('bare');
  assert.equal(bare.gateway.requestRuntimeJob('bare', syntheticInstall('job-4')), true);
  unauthenticated.ws.send(JSON.stringify({ type: 'runtime_job_status', jobId: 'job-4', state: 'succeeded', message: 'private', lines: [] }));
  await until(() => bare.gateway.workers()[0]?.runtimeJob?.state === 'succeeded');
  await bare.stop(unauthenticated);
  assert.equal(observed.length, 0);
});

test('proven local connection observes terminal install failures without reporting disconnect as failure', async () => {
  const observed: NonNullable<Parameters<NonNullable<GatewayHooks['onObservedRuntimeInstall']>>[0]>[] = [];
  const h = await harness({ localSecret: 'synthetic-local-secret', onObservedRuntimeInstall: (o) => observed.push(o), gateway: { echoMs: 0 } });
  const first = await h.connect('local', { origin: 'local', localSecret: 'synthetic-local-secret' });
  assert.equal(h.gateway.requestRuntimeJob('local', syntheticInstall('job-1')), true);
  first.ws.send(JSON.stringify({ type: 'runtime_job_status', jobId: 'job-1', state: 'refused', message: 'private', lines: [] }));
  await until(() => observed.length === 1);
  assert.equal(observed[0]!.state, 'refused');
  assert.equal(observed[0]!.origin, 'local');
  assert.equal(observed[0]!.enrollment, null);
  assert.equal(h.gateway.requestRuntimeJob('local', syntheticInstall('job-2')), true);
  first.ws.close();
  await until(() => h.gateway.workers()[0]?.state !== 'online');
  assert.equal(observed.length, 1);
  await h.stop(first);
});

async function until(predicate: () => boolean, message = '等待超时'): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('终端 RPC：open / resize / close / list 都走同一条通道并原样返回结果', async () => {
  const { gateway, connect, stop } = await harness();
  const wire = await connect();
  const opened = await gateway.openTerminal('w1', { terminalId: 's1:1', sessionId: 's1', cols: 120, rows: 40 });
  assert.deepEqual(opened, { ok: true, value: { cols: 120, rows: 40, reused: false } });
  assert.deepEqual(await gateway.resizeTerminal('w1', 's1:1', 100, 30), { ok: true, value: { ok: true } });
  assert.deepEqual(await gateway.closeTerminal('w1', 's1:1'), { ok: true, value: { ok: true } });
  assert.deepEqual(await gateway.listTerminals('w1'), { ok: true, value: [] });

  const methods = wire.calls.map((call) => call.method);
  assert.ok(methods.includes('terminal.open'));
  assert.ok(methods.includes('terminal.resize'));
  assert.ok(methods.includes('terminal.close'));
  assert.ok(methods.includes('terminal.list'));
  const open = wire.calls.find((call) => call.method === 'terminal.open');
  assert.deepEqual(open?.params, { terminalId: 's1:1', sessionId: 's1', cols: 120, rows: 40 });
  await stop(wire);
});

test('终端 RPC：离线、凭据没有 sessions、worker 回 unsupported 都折成 {ok:false}，不抛错', async () => {
  const { gateway, connect, stop } = await harness({
    authenticate: async () => ({ ok: true, capabilities: ['files.read'] })
  });
  const offline = await gateway.openTerminal('w1', { terminalId: 's1:1', sessionId: 's1', cols: 80, rows: 24 });
  assert.equal(offline.ok, false);
  assert.equal(offline.ok === false && offline.code, 'unavailable');

  const wire = await connect('w1', { credential: 'c1' });
  const denied = await gateway.openTerminal('w1', { terminalId: 's1:1', sessionId: 's1', cols: 80, rows: 24 });
  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false && denied.code, 'forbidden');
  assert.equal(wire.calls.some((call) => call.method === 'terminal.list'), false, '没有 sessions 能力时不该对账');
  await stop(wire);
});

test('终端 RPC：worker 报 unsupported 时保留 code（界面据此隐藏页签）', async () => {
  const { gateway, connect, stop } = await harness({
    reply: (method) => (method === 'terminal.open' ? { error: { code: 'unsupported', message: '这台机器没有 node-pty' } } : { ok: true })
  });
  const wire = await connect();
  const opened = await gateway.openTerminal('w1', { terminalId: 's1:1', sessionId: 's1', cols: 80, rows: 24 });
  assert.deepEqual(opened, { ok: false, code: 'unsupported', message: '这台机器没有 node-pty' });
  await stop(wire);
});

test('worker 重连对账：terminal.list 里 hub 不认识的 terminalId 全发 terminal.close', async () => {
  const { connect, stop } = await harness({
    knownTerminals: () => new Set(['s2:1']),
    reply: (method) =>
      method === 'terminal.list'
        ? {
            terminals: [
              { terminalId: 's1:1', sessionId: 's1' },
              { terminalId: 's2:1', sessionId: 's2' }
            ]
          }
        : { ok: true }
  });
  const wire = await connect();
  await until(() => wire.calls.some((call) => call.method === 'terminal.close'));
  const closed = wire.calls.filter((call) => call.method === 'terminal.close');
  assert.deepEqual(closed.map((call) => call.params), [{ terminalId: 's1:1' }]);
  await stop(wire);
});

test('终端帧：worker 的 terminal_data / terminal_exit 按 terminalId 送到回调，输入走 terminal_input', async () => {
  const data: unknown[] = [];
  const exits: unknown[] = [];
  const { gateway, connect, stop } = await harness({
    onTerminalData: (workerId, terminalId, payload) => data.push({ workerId, terminalId, payload }),
    onTerminalExit: (workerId, terminalId, code) => exits.push({ workerId, terminalId, code })
  });
  const wire = await connect();
  wire.ws.send(JSON.stringify({ type: 'terminal_data', terminalId: 's1:1', data: 'aGk=' }));
  wire.ws.send(JSON.stringify({ type: 'terminal_exit', terminalId: 's1:1', code: 0 }));
  await until(() => data.length === 1 && exits.length === 1);
  assert.deepEqual(data[0], { workerId: 'w1', terminalId: 's1:1', payload: 'aGk=' });
  assert.deepEqual(exits[0], { workerId: 'w1', terminalId: 's1:1', code: 0 });

  assert.equal(gateway.sendTerminalInput('w1', 's1:1', 'bHM='), true);
  await until(() => wire.frames.some((frame) => frame.kind === 'terminal_input'));
  const input = wire.frames.find((frame) => frame.kind === 'terminal_input') as { terminalId: string; data: string };
  assert.equal(input.terminalId, 's1:1');
  assert.equal(input.data, 'bHM=');
  assert.equal(gateway.sendTerminalInput('offline', 's1:1', 'bHM='), false);
  await stop(wire);
});

const bundleInput: ProjectGitBundleImportInput = {
  path: '/work/repo',
  expectedUrl: 'https://git.example.com/o/r.git',
  bundleBase64: 'aGVsbG8=',
  bundleSha256: 'b'.repeat(64),
  tipSha: 'c'.repeat(40),
  ref: `refs/agent-hub/fetch/project-1/${'c'.repeat(40)}`
};

test('项目 Git bundle 导入：未 opt-in 的 Worker 在发送前就拒绝（not_implemented），不回退', async () => {
  const { gateway, connect, stop } = await harness();
  const wire = await connect();
  const outcome = await gateway.importProjectGitBundle('w1', bundleInput);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.error.code, 'not_implemented');
  assert.equal(wire.calls.some((call) => call.method === 'ws.import_project_git_bundle'), false, '未声明能力时不该发任何 RPC');
  await stop(wire);
});

test('项目 Git bundle 导入：凭据没有 git 能力时 forbidden，也不发 RPC', async () => {
  const { gateway, connect, stop } = await harness({ authenticate: async () => ({ ok: true, capabilities: ['files.read'] }) });
  const wire = await connect('w1', { credential: 'c1', capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const outcome = await gateway.importProjectGitBundle('w1', bundleInput);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.error.code, 'forbidden');
  assert.equal(wire.calls.some((call) => call.method === 'ws.import_project_git_bundle'), false);
  await stop(wire);
});

test('项目 Git bundle 导入：opt-in 后六个字段原样发出，结果原样返回', async () => {
  const reply = { ref: bundleInput.ref, tipSha: bundleInput.tipSha, alreadyPresent: true };
  const { gateway, connect, stop } = await harness({
    reply: (method) => (method === 'ws.import_project_git_bundle' ? reply : { ok: true })
  });
  const wire = await connect('w1', { capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const outcome = await gateway.importProjectGitBundle('w1', bundleInput);
  assert.deepEqual(outcome, { ok: true, value: reply });
  const calls = wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle');
  assert.deepEqual(calls.map((call) => call.params), [bundleInput]);
  await stop(wire);
});

test('项目 Git bundle 导入：聚合超时只报「结果未知」，不自动重放', async () => {
  const { gateway, connect, stop } = await harness({
    drop: (method) => method === 'ws.import_project_git_bundle',
    gateway: { projectGitBundleTimeoutMs: 20 }
  });
  const wire = await connect('w1', { capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const outcome = await gateway.importProjectGitBundle('w1', bundleInput);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('应当超时');
  assert.equal(outcome.error.code, 'unavailable');
  assert.match(outcome.error.message, /结果未知/);
  assert.match(outcome.error.message, /不要自动重放/);
  assert.equal(wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle').length, 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle').length, 1, '超时后不应自动重发');
  await stop(wire);
});

test('项目 Git bundle 导入：出站参数不合法（SHA / 字段 / ref 绑定）在发送前拒绝，一个字节都不发', async () => {
  const { gateway, connect, stop } = await harness();
  const wire = await connect('w1', { capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const outcome = await gateway.importProjectGitBundle('w1', { ...bundleInput, tipSha: 'C'.repeat(40) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.error.code, 'invalid');
  assert.equal(wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle').length, 0, '参数不合法时不该发任何 RPC');
  await stop(wire);
});

test('项目 Git bundle 导入：超过固定 8 MiB（base64 上限）在发送前拒绝，一个字节都不发', async () => {
  const { gateway, connect, stop } = await harness();
  const wire = await connect('w1', { capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const outcome = await gateway.importProjectGitBundle('w1', {
    ...bundleInput,
    bundleBase64: 'A'.repeat(PROJECT_GIT_BUNDLE_MAX_BASE64_BYTES + 1)
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.error.code, 'invalid');
  assert.equal(wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle').length, 0, '超大 bundle 不该被塞进 WebSocket');
  await stop(wire);
});

test('项目 Git bundle 导入：响应自洽但 ref / tip 不是这次请求的，按「结果未知」处理且不重放', async () => {
  const otherSha = 'e'.repeat(40);
  const { gateway, connect, stop } = await harness({
    reply: (method) =>
      method === 'ws.import_project_git_bundle'
        ? { ref: `refs/agent-hub/fetch/project-2/${otherSha}`, tipSha: otherSha, alreadyPresent: true }
        : { ok: true }
  });
  const wire = await connect('w1', { capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const outcome = await gateway.importProjectGitBundle('w1', bundleInput);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('应当报结果未知');
  assert.equal(outcome.error.code, 'unavailable');
  assert.match(outcome.error.message, /结果未知/);
  assert.match(outcome.error.message, /不要自动重放/);
  assert.equal(wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle').length, 1);
  await stop(wire);
});

test('项目 Git bundle 导入：响应不合协议（bad_result）同样报「结果未知」，不重放', async () => {
  const { gateway, connect, stop } = await harness({
    reply: (method) => (method === 'ws.import_project_git_bundle' ? { ref: bundleInput.ref, tipSha: 'not-a-sha' } : { ok: true })
  });
  const wire = await connect('w1', { capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const outcome = await gateway.importProjectGitBundle('w1', bundleInput);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('应当报结果未知');
  assert.equal(outcome.error.code, 'unavailable');
  assert.match(outcome.error.message, /结果未知/);
  assert.equal(wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle').length, 1);
  await stop(wire);
});

test('项目 Git bundle 导入：对端明确 unknown_method 时诚实报未实现，不回退也不重放', async () => {
  const { gateway, connect, stop } = await harness({
    reply: (method) =>
      method === 'ws.import_project_git_bundle' ? { error: { code: 'unknown_method', message: 'unknown method' } } : { ok: true }
  });
  const wire = await connect('w1', { capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const outcome = await gateway.importProjectGitBundle('w1', bundleInput);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.error.code, 'not_implemented');
  assert.equal(wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle').length, 1);
  await stop(wire);
});

test('项目 Git bundle 导入：等待期间断线按「结果未知」处理，不自动重放', async () => {
  const { gateway, connect, stop } = await harness({ drop: (method) => method === 'ws.import_project_git_bundle' });
  const wire = await connect('w1', { capabilities: [WORKER_CAPABILITY_PROJECT_GIT_BUNDLE_IMPORT] });
  const pending = gateway.importProjectGitBundle('w1', bundleInput);
  await until(() => wire.calls.some((call) => call.method === 'ws.import_project_git_bundle'));
  wire.ws.close();
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('断线应当报结果未知');
  assert.equal(outcome.error.code, 'unavailable');
  assert.match(outcome.error.message, /结果未知/);
  assert.equal(wire.calls.filter((call) => call.method === 'ws.import_project_git_bundle').length, 1);
  await stop(wire);
});

/** 两条内存 RPC 通道直连：验证 Worker 侧 handler 的输入 / 单飞 / 错误翻译。 */
function rpcPair(): { readonly a: RpcChannel; readonly b: RpcChannel } {
  const ends: RpcChannel[] = [];
  ends.push(createRpcChannel({ idPrefix: 'a', timeoutMs: 500, send: (frame) => (queueMicrotask(() => ends[1]?.receive(frame)), true) }));
  ends.push(createRpcChannel({ idPrefix: 'b', timeoutMs: 500, send: (frame) => (queueMicrotask(() => ends[0]?.receive(frame)), true) }));
  return { a: ends[0]!, b: ends[1]! };
}

test('项目 Git bundle 导入（Worker 侧）：注入的导入器收到精确六字段；单飞期间第二个请求 conflict，settle 后才释放', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: ProjectGitBundleImportInput[] = [];
  const importer: ProjectGitBundleImporter = {
    async importBundle(input) {
      seen.push({ ...input });
      await gate;
      return { ok: true, value: { ref: input.ref, tipSha: input.tipSha, alreadyPresent: false } };
    }
  };
  const { a, b } = rpcPair();
  serveProjectGitBundleImport(b, importer);

  const first = a.request(wsImportProjectGitBundle, bundleInput);
  await until(() => seen.length === 1);
  const otherSha = 'd'.repeat(40);
  const second = await a.request(wsImportProjectGitBundle, { ...bundleInput, tipSha: otherSha, ref: `refs/agent-hub/fetch/project-1/${otherSha}` });
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.error.code, 'conflict');
  assert.equal(seen.length, 1, '第二个请求不该进入导入器');

  release();
  assert.deepEqual(await first, { ok: true, value: { ref: bundleInput.ref, tipSha: bundleInput.tipSha, alreadyPresent: false } });
  assert.deepEqual(seen[0], bundleInput);
});

test('项目 Git bundle 导入（Worker 侧）：导入器失败只翻译 code，文案固定中性（不回传导入器 message）', async () => {
  const { a, b } = rpcPair();
  serveProjectGitBundleImport(b, {
    async importBundle() {
      return { ok: false, error: { code: 'conflict', message: '工作目录 /secret/path 状态不允许导入' } };
    }
  });
  assert.deepEqual(await a.request(wsImportProjectGitBundle, bundleInput), {
    ok: false,
    error: { code: 'conflict', message: '工作目录状态与项目 Git bundle 导入冲突，未创建 ref' }
  });
});

test('项目 Git bundle 导入（Worker 侧）：导入器抛错也换成固定中性文案，不泄露原始信息', async () => {
  const { a, b } = rpcPair();
  serveProjectGitBundleImport(b, {
    async importBundle() {
      throw new Error('git failed at /home/u/repo: bad object deadbeef');
    }
  });
  const outcome = await a.request(wsImportProjectGitBundle, bundleInput);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('应当失败');
  assert.equal(outcome.error.code, 'failed');
  assert.equal(outcome.error.message, '项目 Git bundle 导入失败（结果未知；先核对 ref，不要自动重放）');
  assert.equal(/deadbeef|\/home\/u\/repo/.test(outcome.error.message), false);
});
