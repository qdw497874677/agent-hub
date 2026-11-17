import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '@agent-hub/domain';
import {
  asAgentId,
  createGitToolProvider,
  createProjectUseCase,
  createTaskToolProvider,
  createTaskUseCase,
  createToolGateway,
  deriveSessionUseCase,
  ok,
  withToolAccess,
  type GitWorkflow,
  type ToolProvider
} from '@agent-hub/domain';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { fakeToolGrants, inMemoryDeps } from '@agent-hub/domain/testing';
import { createRpcChannel, mcpMessage, type RpcChannel } from '@agent-hub/contract';
import { serveMcpRelay, type RemoteClients, type RemoteMcpTarget } from './mcp-relay.ts';
import type { McpOAuthClient } from './mcp-oauth.ts';

const fake = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: Object.fromEntries(
    ['prompt', 'interrupt', 'fork', 'resume', 'tool_calls', 'artifacts', 'structured_events', 'attachments'].map((k) => [k, { state: 'available' }])
  ),
  models: ['m1'],
  defaultModel: 'm1',
  options: []
} as unknown as AgentDescriptor;

function linked(): [RpcChannel, RpcChannel] {
  const ends: RpcChannel[] = [];
  ends.push(createRpcChannel({ idPrefix: 'w', send: (f) => (queueMicrotask(() => ends[1]!.receive(f)), true) }));
  ends.push(createRpcChannel({ idPrefix: 'h', send: (f) => (queueMicrotask(() => ends[0]!.receive(f)), true) }));
  return [ends[0]!, ends[1]!];
}

async function setup(extraProviders: readonly ToolProvider[] = []) {
  const w = inMemoryDeps();
  w.agents.push(fake);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '走长链接', ownerId: 'u1' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  let n = 0;
  const gateway = createToolGateway({
    now: w.deps.now,
    toolGrants: fakeToolGrants(),
    tokens: { issue: () => ({ token: `tok-${++n}`, hash: `h-tok-${n}` }), hashOf: (t: string) => `h-${t}` },
    providers: [createTaskToolProvider(w.deps), ...extraProviders]
  });
  const command = await withToolAccess(gateway, { url: '', transport: 'relay' }, {
    kind: 'start_session',
    sessionId: session.value.id,
    taskId: task.value.id,
    workerId: 'w1'
  } as never);
  const token = (command as { tools: { token: string; transport: string } }).tools.token;
  assert.equal((command as { tools: { transport: string } }).tools.transport, 'relay');
  return { gateway, token, sessionId: session.value.id as string };
}

const call = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method, params });

test('hub MCP 中转：令牌对、会话在这台 Worker 上 → 交给 MCP 服务端读任务、写日志', async () => {
  const s = await setup();
  const [worker, hub] = linked();
  serveMcpRelay(hub, 'w1', { gateway: s.gateway, hostOf: (id) => (id === s.sessionId ? 'w1' : null) });
  const listed = await worker.request(mcpMessage, { token: s.token, message: call(1, 'tools/list') });
  assert.ok(listed.ok);
  const names = ((listed.value.message?.['result'] as { tools: { name: string }[] }).tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(names, ['task_get', 'task_log_append', 'task_log_list', 'task_update_status']);
  const got = await worker.request(mcpMessage, { token: s.token, message: call(2, 'tools/call', { name: 'task_get', arguments: {} }) });
  assert.ok(got.ok);
  assert.match(JSON.stringify(got.value.message), /走长链接/);
  // 通知：无状态，没有回复
  const note = await worker.request(mcpMessage, { token: s.token, message: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.deepEqual(note, { ok: true, value: { message: null } });
});

test('hub MCP 中转：默认授权下 git.* 对模型可见', async () => {
  const git = createGitToolProvider({ workflow: {} as GitWorkflow, subjectOf: async () => null });
  const s = await setup([git]);
  const [worker, hub] = linked();
  serveMcpRelay(hub, 'w1', { gateway: s.gateway, hostOf: (id) => (id === s.sessionId ? 'w1' : null) });
  const listed = await worker.request(mcpMessage, { token: s.token, message: call(1, 'tools/list') });
  assert.ok(listed.ok);
  const names = ((listed.value.message?.['result'] as { tools: { name: string }[] }).tools ?? []).map((t) => t.name);
  for (const name of ['git_state', 'git_commit', 'git_push', 'git_pr', 'git_pull_requests']) assert.ok(names.includes(name), name);
});

test('hub MCP 中转：假令牌、别的 Worker、会话已不在这台上，一律 forbidden；会话结束令牌作废', async () => {
  const s = await setup();
  const [w1, hub1] = linked();
  serveMcpRelay(hub1, 'w1', { gateway: s.gateway, hostOf: () => 'w1' });
  const bogus = await w1.request(mcpMessage, { token: 'nope', message: call(1, 'tools/list') });
  assert.equal(!bogus.ok && bogus.error.code, 'forbidden');

  const [w2, hub2] = linked();
  serveMcpRelay(hub2, 'w2', { gateway: s.gateway, hostOf: () => 'w2' });
  const foreign = await w2.request(mcpMessage, { token: s.token, message: call(1, 'tools/list') });
  assert.equal(!foreign.ok && foreign.error.code, 'forbidden');

  const [w3, hub3] = linked();
  serveMcpRelay(hub3, 'w1', { gateway: s.gateway, hostOf: () => 'w9' });
  const moved = await w3.request(mcpMessage, { token: s.token, message: call(1, 'tools/list') });
  assert.equal(!moved.ok && moved.error.code, 'forbidden');

  await withToolAccess(s.gateway, { url: '', transport: 'relay' }, { kind: 'dispose', sessionId: s.sessionId, workerId: 'w1' } as never);
  const revoked = await w1.request(mcpMessage, { token: s.token, message: call(2, 'tools/list') });
  assert.equal(!revoked.ok && revoked.error.code, 'forbidden');
});

interface Seen {
  headers: Record<string, string>[];
  methods: string[];
  drops: number;
}

/** 假的上游 MCP 客户端：只实现 relay 会用到的请求，并记下调用顺序。 */
function upstreamClient(seen: Seen): Client {
  return {
    async listTools() {
      seen.methods.push('tools/list');
      return {
        tools: [
          { name: 'alpha', description: 'a', inputSchema: { type: 'object' as const } },
          { name: 'blocked', description: 'b', inputSchema: { type: 'object' as const } }
        ]
      };
    },
    async callTool(params: { name: string }) {
      seen.methods.push(`tools/call:${params.name}`);
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    },
    async listResources() {
      seen.methods.push('resources/list');
      return { resources: [{ uri: 'file:///a.txt', name: 'a' }] };
    },
    async listResourceTemplates() {
      seen.methods.push('resources/templates/list');
      return { resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 't' }] };
    },
    async readResource(params: { uri: string }) {
      seen.methods.push(`resources/read:${params.uri}`);
      return { contents: [{ uri: params.uri, text: 'hello' }] };
    },
    async listPrompts() {
      seen.methods.push('prompts/list');
      return { prompts: [{ name: 'greet', description: 'g' }] };
    },
    async getPrompt(params: { name: string }) {
      seen.methods.push(`prompts/get:${params.name}`);
      return {
        description: 'g',
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `hi ${params.name}` } }]
      };
    }
  } as unknown as Client;
}

/** 起一个只代理远端 MCP 的 relay：假客户端、可注入 OAuth、可选让前 N 次 get 返回 401。 */
async function relayTo(
  target: RemoteMcpTarget,
  options: { oauth?: McpOAuthClient; failGets?: number } = {}
): Promise<{ worker: RpcChannel; token: string; seen: Seen }> {
  const s = await setup();
  const [worker, hub] = linked();
  const seen: Seen = { headers: [], methods: [], drops: 0 };
  let gets = 0;
  const remoteClients: RemoteClients = {
    async get(t) {
      gets += 1;
      seen.headers.push(t.headers);
      if (gets <= (options.failGets ?? 0)) {
        return {
          async listTools() {
            seen.methods.push('tools/list');
            throw Object.assign(new Error('HTTP 401 Unauthorized'), { status: 401 });
          }
        } as unknown as Client;
      }
      return upstreamClient(seen);
    },
    async drop() {
      seen.drops += 1;
    },
    async close() {}
  };
  serveMcpRelay(hub, 'w1', {
    gateway: s.gateway,
    hostOf: (id) => (id === s.sessionId ? 'w1' : null),
    remote: async () => ok(target),
    remoteClients,
    ...(options.oauth ? { oauth: options.oauth } : {})
  });
  return { worker, token: s.token, seen };
}

const target: RemoteMcpTarget = { url: 'https://mcp.example.test/mcp', headers: {} };

test('远端 MCP：resources / prompts 的五个请求都转发给上游并带回结果', async () => {
  const { worker, token, seen } = await relayTo(target);

  const resources = await worker.request(mcpMessage, { token, server: 'demo', message: call(1, 'resources/list') });
  assert.ok(resources.ok);
  assert.deepEqual(
    ((resources.value.message?.['result'] as { resources: { uri: string }[] }).resources ?? []).map((r) => r.uri),
    ['file:///a.txt']
  );

  const templates = await worker.request(mcpMessage, { token, server: 'demo', message: call(2, 'resources/templates/list') });
  assert.ok(templates.ok);
  assert.deepEqual(
    ((templates.value.message?.['result'] as { resourceTemplates: { uriTemplate: string }[] }).resourceTemplates ?? []).map(
      (r) => r.uriTemplate
    ),
    ['file:///{path}']
  );

  const read = await worker.request(mcpMessage, { token, server: 'demo', message: call(3, 'resources/read', { uri: 'file:///a.txt' }) });
  assert.ok(read.ok);
  assert.match(JSON.stringify(read.value.message), /hello/);

  const prompts = await worker.request(mcpMessage, { token, server: 'demo', message: call(4, 'prompts/list') });
  assert.ok(prompts.ok);
  assert.deepEqual(
    ((prompts.value.message?.['result'] as { prompts: { name: string }[] }).prompts ?? []).map((p) => p.name),
    ['greet']
  );

  const prompt = await worker.request(mcpMessage, { token, server: 'demo', message: call(5, 'prompts/get', { name: 'greet', arguments: {} }) });
  assert.ok(prompt.ok);
  assert.match(JSON.stringify(prompt.value.message), /hi greet/);

  assert.deepEqual(seen.methods, [
    'resources/list',
    'resources/templates/list',
    'resources/read:file:///a.txt',
    'prompts/list',
    'prompts/get:greet'
  ]);
});

test('远端 MCP：tools.deny 时 ListTools 隐藏被禁工具，CallTool 直接报 -32602 且不打上游', async () => {
  const { worker, token, seen } = await relayTo({ ...target, tools: { deny: ['blocked'] } });

  const listed = await worker.request(mcpMessage, { token, server: 'demo', message: call(1, 'tools/list') });
  assert.ok(listed.ok);
  const names = ((listed.value.message?.['result'] as { tools: { name: string }[] }).tools ?? []).map((t) => t.name);
  assert.deepEqual(names, ['alpha']);

  const denied = await worker.request(mcpMessage, { token, server: 'demo', message: call(2, 'tools/call', { name: 'blocked', arguments: {} }) });
  assert.ok(denied.ok);
  const error = denied.value.message?.['error'] as { code: number; message: string } | undefined;
  assert.ok(error);
  assert.equal(error.code, -32602);
  assert.match(error.message, /这个工具在 MCP 配置里被关掉了/);
  assert.ok(!seen.methods.includes('tools/call:blocked'));

  // allow 之外的也拒；放行的仍能调用。
  const allowed = await worker.request(mcpMessage, { token, server: 'demo', message: call(3, 'tools/call', { name: 'alpha', arguments: {} }) });
  assert.ok(allowed.ok);
  assert.ok(seen.methods.includes('tools/call:alpha'));
});

test('远端 MCP：OAuth 时上游收到 Bearer 头，且覆盖已有 Authorization', async () => {
  const oauthCalls: boolean[] = [];
  const oauth: McpOAuthClient = {
    async authorization(_config, opts) {
      oauthCalls.push(opts?.force === true);
      return ok(`Bearer tok-${oauthCalls.length}`);
    }
  };
  const { worker, token, seen } = await relayTo(
    {
      ...target,
      headers: { 'X-Api-Key': 'k', authorization: 'Bearer stale' },
      oauth: { tokenUrl: 'https://auth.example.test/token', clientId: 'cid', clientSecret: 'sec', authStyle: 'basic' }
    },
    { oauth }
  );
  const listed = await worker.request(mcpMessage, { token, server: 'demo', message: call(1, 'tools/list') });
  assert.ok(listed.ok);
  assert.deepEqual(oauthCalls, [false]);
  const [headers] = seen.headers;
  assert.ok(headers);
  assert.equal(headers['X-Api-Key'], 'k');
  assert.equal(headers['Authorization'], 'Bearer tok-1');
  assert.equal(Object.keys(headers).filter((key) => key.toLowerCase() === 'authorization').length, 1);
});

test('远端 MCP：上游 401 时强制刷新 token 重试一次；仍 401 则报错', async () => {
  const makeOauth = (): { oauth: McpOAuthClient; calls: boolean[] } => {
    const calls: boolean[] = [];
    return {
      calls,
      oauth: {
        async authorization(_config, opts) {
          calls.push(opts?.force === true);
          return ok(`Bearer tok-${calls.length}`);
        }
      }
    };
  };
  const targetWithOAuth: RemoteMcpTarget = {
    ...target,
    oauth: { tokenUrl: 'https://auth.example.test/token', clientId: 'cid', clientSecret: 'sec', authStyle: 'post' }
  };

  const first = makeOauth();
  const retried = await relayTo(targetWithOAuth, { oauth: first.oauth, failGets: 1 });
  const listed = await retried.worker.request(mcpMessage, { token: retried.token, server: 'demo', message: call(1, 'tools/list') });
  assert.ok(listed.ok);
  assert.ok(listed.value.message?.['result']);
  assert.deepEqual(first.calls, [false, true]);
  assert.equal(retried.seen.drops, 1);
  assert.equal(retried.seen.headers[1]?.['Authorization'], 'Bearer tok-2');

  const second = makeOauth();
  const exhausted = await relayTo(targetWithOAuth, { oauth: second.oauth, failGets: 2 });
  const failed = await exhausted.worker.request(mcpMessage, { token: exhausted.token, server: 'demo', message: call(1, 'tools/list') });
  assert.ok(failed.ok);
  const error = failed.value.message?.['error'] as { message: string } | undefined;
  assert.ok(error);
  assert.match(error.message, /远端 MCP 不可用/);
  assert.deepEqual(second.calls, [false, true]);
});
