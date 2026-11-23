import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  asAgentId,
  asLoginId,
  asTeamId,
  asUserId,
  canonicalLink,
  createMessageBus,
  createMessageToolProvider,
  createProject,
  createTask,
  createToolGateway,
  deriveSession,
  ok,
  type Principal,
  type Session,
  type Task,
  type User
} from '@agent-hub/domain';
import { fakeSessionLinks, fakeToolGrants, inMemoryDeps } from '@agent-hub/domain/testing';
import { openSqliteStore, type SqliteStore } from '@agent-hub/storage-sqlite';
import { createMcpServer } from './mcp-server.ts';

/**
 * 会话通信任务树范围：从「同一棵顶层任务树」自动发现同伴，不需要画布拖线。
 *
 * 这里走的是生产 MCP 线上边界：真正的 createMessageToolProvider 注册进
 * createToolGateway，再用真 SDK Client + InMemoryTransport 调 agent_peers / agent_send。
 * （wireTools 在组合根里注册的也是同一个 provider；为免拉整条 SQLite 组合根，
 * 这里只借用 SQLite 的 messages 存储，其余端口用 domain 的内存实现。）
 *
 * 种子数据尽量用生产领域函数：createProject / createTask（含 parent 快照）/ deriveSession，
 * 而不是手工拼 Task / Session 字面量。
 */

interface Setup {
  readonly clients: {
    readonly sibA: Client;
  };
  readonly sessions: {
    readonly sibA: Session;
    readonly sibB: Session;
    readonly otherTree: Session;
    readonly linkedOtherTree: Session;
  };
  readonly messages: SqliteStore['messages'];
  readonly delivered: { sessionId: string; text: string }[];
}

async function setup(t: TestContext): Promise<Setup> {
  const world = inMemoryDeps();
  const deps = world.deps;
  const links = fakeSessionLinks();
  const store = openSqliteStore(':memory:');
  t.after(() => store.close());
  const messages = store.messages;
  const delivered: { sessionId: string; text: string }[] = [];

  // 所有被种子出来的会话都属于 u1；没有额外策略时，只要 principal 存在就放行。
  const principal: Principal = {
    user: {
      id: asUserId('u1'),
      email: 'u1@example.com',
      displayName: 'u1',
      role: 'member',
      passwordHash: null,
      emailVerifiedAt: 1,
      disabledAt: null,
      createdAt: 1,
      teamId: asTeamId('T'),
      clusterAdmin: false,
      deletedAt: null
    } satisfies User,
    loginId: asLoginId('login-u1')
  };

  const project = createProject({ name: 'tree', now: 1, teamId: 'T', createdBy: 'u1' });
  assert.ok(project.ok);
  await deps.projects.save(project.value);

  const seedTask = async (title: string, parent?: Task): Promise<Task> => {
    const task = createTask({
      projectId: project.value.id,
      title,
      now: 1,
      ...(parent ? { parent, parentTaskId: parent.id } : {})
    });
    assert.ok(task.ok);
    await deps.tasks.save(task.value);
    return task.value;
  };
  const seedSession = async (task: Task): Promise<Session> => {
    const session = deriveSession({ task, agentId: asAgentId('pi'), model: '', now: 1, createdBy: 'u1' });
    assert.ok(session.ok);
    await deps.sessions.save(session.value);
    return session.value;
  };

  // 同一棵树：root → childA / childB。兄弟之间没有任何显式连接。
  const root = await seedTask('root');
  const childA = await seedTask('child A', root);
  const childB = await seedTask('child B', root);
  // 另一棵树：root2 → childC / childD。childC 会显式连到 sibA，childD 保持隔离。
  const root2 = await seedTask('root 2');
  const childC = await seedTask('child C', root2);
  const childD = await seedTask('child D', root2);

  const sibA = await seedSession(childA);
  const sibB = await seedSession(childB);
  const otherTree = await seedSession(childD);
  const linkedOtherTree = await seedSession(childC);
  await links.save(canonicalLink(project.value.id, sibA.id, linkedOtherTree.id, 'u1', 1));

  const bus = createMessageBus({
    now: deps.now,
    sessions: deps.sessions,
    projects: deps.projects,
    workspaces: deps.workspaces,
    workspaceGroups: deps.workspaceGroups,
    tasks: deps.tasks,
    bots: deps.bots,
    links,
    messages,
    principalOf: async () => principal,
    deliver: async (sessionId, text) => {
      delivered.push({ sessionId, text });
      return ok(undefined);
    },
    spawn: async () => {
      throw new Error('本测试不派生 bot 会话');
    }
  });

  let tokenSeq = 0;
  const gateway = createToolGateway({
    now: deps.now,
    toolGrants: fakeToolGrants(),
    tokens: {
      issue: () => {
        const n = ++tokenSeq;
        return { token: `tok-${n}`, hash: `h-tok-${n}` };
      },
      hashOf: (token) => `h-${token}`
    },
    providers: [createMessageToolProvider(bus)]
  });

  const connect = async (session: Session): Promise<Client> => {
    const issued = await gateway.issue(session);
    // 走一次真实令牌认证，而不是直接把 issue 的 grant 塞给 MCP 服务端。
    const grant = await gateway.authenticate(issued.token);
    assert.ok(grant);
    const server = createMcpServer(gateway, grant);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'session-tree', version: '1' });
    await client.connect(clientTransport);
    return client;
  };

  const clientA = await connect(sibA);
  t.after(async () => clientA.close());
  return {
    clients: { sibA: clientA },
    sessions: { sibA, sibB, otherTree, linkedOtherTree },
    messages,
    delivered
  };
}

interface ToolResult {
  readonly isError?: boolean;
  readonly content: readonly { type: string; text: string }[];
  readonly structuredContent?: unknown;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

const items = (result: ToolResult): Record<string, unknown>[] =>
  (result.structuredContent as { items?: Record<string, unknown>[] }).items ?? [];

test('MCP agent_peers：兄弟任务会话自动出现在同一棵树里，relation=task_tree 且不算 connected', async (t) => {
  const s = await setup(t);
  const result = await call(s.clients.sibA, 'agent_peers');
  assert.ok(!result.isError, result.content[0]?.text);
  const peers = items(result);

  const sibling = peers.find((peer) => peer.address === `session:${s.sessions.sibB.id}`);
  assert.ok(sibling, `没发现同树兄弟：${JSON.stringify(peers)}`);
  assert.equal(sibling.relation, 'task_tree');
  // connected 只表示画布 / 对话页的显式连接，任务树自动发现不能伪装成显式连接。
  assert.equal(sibling.connected, undefined);
  assert.equal(typeof sibling.handle, 'string');

  // 显式连到另一棵树的会话：仍然保留 connected=true 和 relation=explicit。
  const explicit = peers.find((peer) => peer.address === `session:${s.sessions.linkedOtherTree.id}`);
  assert.ok(explicit, `没发现显式连线的会话：${JSON.stringify(peers)}`);
  assert.equal(explicit.connected, true);
  assert.equal(explicit.relation, 'explicit');
});

test('MCP agent_directory：同树兄弟可被发现，显式边标 connected', async (t) => {
  const s = await setup(t);
  const result = await call(s.clients.sibA, 'agent_directory');
  assert.ok(!result.isError, result.content[0]?.text);
  const entries = items(result);

  const sibling = entries.find((entry) => entry.address === `session:${s.sessions.sibB.id}`);
  assert.ok(sibling, `目录里没有同树兄弟：${JSON.stringify(entries)}`);
  assert.equal(sibling.relation, 'task_tree');
  assert.equal(sibling.connected, undefined);

  const explicit = entries.find((entry) => entry.address === `session:${s.sessions.linkedOtherTree.id}`);
  assert.ok(explicit);
  assert.equal(explicit.connected, true);
  assert.equal(explicit.relation, 'explicit');
});

test('MCP agent_send：用 agent_peers 给出的 peer:<handle> 给同树兄弟发消息，真的投递成功', async (t) => {
  const s = await setup(t);
  const peers = items(await call(s.clients.sibA, 'agent_peers'));
  const sibling = peers.find((peer) => peer.address === `session:${s.sessions.sibB.id}`);
  assert.ok(sibling);
  const handle = sibling.handle;
  assert.equal(typeof handle, 'string');

  const sent = await call(s.clients.sibA, 'agent_send', { to: `peer:${handle}`, body: '同树兄弟你好' });
  assert.ok(!sent.isError, sent.content[0]?.text);
  const ack = JSON.parse(sent.content[0]!.text) as { messageId: string; targetSessionId: string; status: string };
  assert.equal(ack.targetSessionId, s.sessions.sibB.id);
  assert.equal(ack.status, 'delivered');
  const saved = await s.messages.byId(ack.messageId);
  assert.equal(saved?.targetSessionId, s.sessions.sibB.id);
  assert.deepEqual(s.delivered.map((entry) => entry.sessionId), [s.sessions.sibB.id]);
});

test('MCP agent_send：另一棵任务树、又没显式连线 → denied，不放宽成全局可达', async (t) => {
  const s = await setup(t);
  const denied = await call(s.clients.sibA, 'agent_send', {
    to: `session:${s.sessions.otherTree.id}`,
    body: '这条不该送出去'
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0]?.text ?? '', /同一任务树/);
  const history = await s.messages.forSession(s.sessions.sibA.id, 10);
  assert.equal(
    history.some((message) => message.fromSessionId === s.sessions.sibA.id && message.targetSessionId === s.sessions.otherTree.id),
    false
  );
});

test('MCP agent_send：显式连线跨任务树仍然可发，旧的显式边行为不变', async (t) => {
  const s = await setup(t);
  const sent = await call(s.clients.sibA, 'agent_send', {
    to: `session:${s.sessions.linkedOtherTree.id}`,
    body: '显式连线照旧'
  });
  assert.ok(!sent.isError, sent.content[0]?.text);
  const ack = JSON.parse(sent.content[0]!.text) as { targetSessionId: string; status: string };
  assert.equal(ack.targetSessionId, s.sessions.linkedOtherTree.id);
  assert.equal(ack.status, 'delivered');
});
