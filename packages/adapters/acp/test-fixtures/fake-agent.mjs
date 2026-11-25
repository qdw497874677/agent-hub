// 最小的 ACP agent（ndjson over stdio），只给 acp-runtime 的测试用。
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
// --fork：像 claude-agent-acp 那样声明 session/fork、每条 assistant 消息带 messageId、认 _meta.jetbrains.air.fork（ADR 0028）
const FORK = process.argv.includes('--fork');
// --fork-fail：声明了 fork，但真分叉时报错（原生分叉失败的退路）
const FORK_FAIL = process.argv.includes('--fork-fail');
// --child：模拟 OpenCode 的 child session updates（子代理事件带 _meta['opencode/child-session']）
const CHILD = process.argv.includes('--child');
// --mcp-http：像支持 Streamable HTTP MCP 的 agent 那样声明 mcpCapabilities.http=true，
// 并在 prompt 里真的用 session/new 下发的 mcpServers 调工具（workspace delegation e2e 用）。
const MCP_HTTP = process.argv.includes('--mcp-http');
let turn = 0;
let forkedAt = null;
const say = (sessionId, text) =>
  send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(FORK ? { messageId: `m-${sessionId}-${turn}` } : {}) } } });

// --models：像 `opencode models` 那样列模型就退出
if (process.argv.includes('--models')) {
  process.stdout.write('fake/m1\nfake/m2\n');
  process.exit(0);
}
// --empty-all：每一轮都什么都不回（模拟模型 / 鉴权坏掉的 agent）
const EMPTY_ALL = process.argv.includes('--empty-all');
process.stderr.write('fake agent booting\n');

// --gate-dir <目录>：门控文件信号（e2e 排序用）。prompt 里出现
//   please-hold:<key> → 先写 <目录>/hold-<key>.started（证明这一轮真的进了运行时），
//                        再等 <目录>/hold-<key>.go 出现才回 end_turn；
//   please-mark:<key> → 只写 <目录>/mark-<key>.started，然后正常回一句结束。
// 用文件而不是 sleep：测试能确定「这一轮开始了没有」，也能自己决定它什么时候结束。
const gateFlag = process.argv.indexOf('--gate-dir');
const GATE_DIR = gateFlag >= 0 ? process.argv[gateFlag + 1] : null;
const startupGateFlag = process.argv.indexOf('--startup-gate');
const STARTUP_GATE = startupGateFlag >= 0 ? process.argv[startupGateFlag + 1] : null;
const sessionRefFlag = process.argv.indexOf('--session-ref');
const SESSION_REF = sessionRefFlag >= 0 ? process.argv[sessionRefFlag + 1] : 's1';

let model = 'a';
let mode = 'default';
// --legacy：像 Hermes 0.22.5 那样只报老式 models/modes，不报 configOptions
const LEGACY = process.argv.includes('--legacy');
const reported = () =>
  LEGACY
    ? { models: { availableModels: [{ modelId: 'custom:a', name: 'A' }], currentModelId: model }, modes: { availableModes: [{ id: 'default', name: 'Default' }, { id: 'accept_edits', name: 'Accept' }], currentModeId: mode } }
    : { configOptions: options() };
const options = () => [
  { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: model, options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }
];
const seen = [];
let pendingPrompt;
let pendingPromptSession;
let cwd = process.cwd();
// session/new 下发的 MCP server 清单（hub 的工具入口；--mcp-http 时才有用）。
let mcpServers = [];
// --please-backlog：回合在后台子代理还在跑时就 end_turn；总结只出现在之后的 session/load 重放里
// （opencode 的 ACP 适配器真实行为：prompt 返回后不再推 session/update）。
let backlogSummary = null;

const backlogText = (sessionId, messageId, text) =>
  send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId } } });
const backlogThought = (sessionId, messageId, text) =>
  send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text }, messageId } } });

// 最小 Streamable HTTP MCP 客户端：一个 POST 一个 JSON-RPC（hub 的入口开了 enableJsonResponse）。
async function mcpCall(server, body) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  for (const header of server.headers ?? []) headers[header.name] = header.value;
  const response = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP ${response.status}: ${text.slice(0, 200)}`);
  if (text === '') return null;
  return JSON.parse(text);
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    // 我们发出的 request_permission 的回答
    say(pendingPromptSession, `perm:${msg.result.outcome.optionId}`);
    send({ id: pendingPrompt, result: { stopReason: 'end_turn' } });
    return;
  }
  seen.push(msg.method + (msg.params?._meta ? JSON.stringify(msg.params._meta) : ''));
  switch (msg.method) {
    case 'initialize': {
      const capabilities = {
        ...(FORK ? { sessionCapabilities: { fork: {} } } : {}),
        ...(MCP_HTTP ? { mcpCapabilities: { http: true } } : {})
      };
      return send({ id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'key', name: 'Key' }], ...(Object.keys(capabilities).length > 0 ? { agentCapabilities: capabilities } : {}) } });
    }
    case 'session/fork': {
      if (FORK_FAIL) return send({ id: msg.id, error: { code: -32603, message: 'fake fork failure' } });
      if (typeof msg.params?.cwd === 'string') cwd = msg.params.cwd;
      forkedAt = msg.params?._meta?.jetbrains?.air?.fork?.messageId ?? 'latest';
      return send({ id: msg.id, result: { sessionId: `f-${forkedAt}`, ...reported() } });
    }
    case 'authenticate':
      return send({ id: msg.id, result: {} });
    case 'session/new':
      if (STARTUP_GATE) {
        appendFileSync(`${STARTUP_GATE}.started`, 'start\n');
        while (!existsSync(`${STARTUP_GATE}.go`) && !existsSync(`${STARTUP_GATE}.fail`)) {
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        if (existsSync(`${STARTUP_GATE}.fail`)) {
          return send({ id: msg.id, error: { code: -32603, message: 'synthetic ACP startup failure' } });
        }
      }
      if (typeof msg.params?.cwd === 'string') cwd = msg.params.cwd;
      if (Array.isArray(msg.params?.mcpServers)) mcpServers = msg.params.mcpServers;
      if (LEGACY) model = 'custom:a';
      return send({ id: msg.id, result: { sessionId: SESSION_REF, ...reported() } });
    case 'session/load': {
      const sid = msg.params.sessionId;
      if (STARTUP_GATE && sessionRefFlag >= 0) appendFileSync(`${STARTUP_GATE}.loaded`, `${sid}\n`);
      // 重新托管走 session/load；真实 ACP 会在 load 时重新注入 MCP server 清单，
      // fake 也要跟着换，否则还拿旧 token 的 URL 调工具。
      if (Array.isArray(msg.params?.mcpServers)) mcpServers = msg.params.mcpServers;
      if (backlogSummary) {
        // 真实 opencode 会把整段历史重放一遍：旧 thought 被合并成一块、旧文本原样再来、
        // 后台子代理完成后的总结只在最后出现（并**没有**子代理的 child_update）。
        backlogThought(sid, 'b-thought', '先看看');
        send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'p1', title: 'subagent', kind: 'other', rawInput: {} } } });
        send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call_update', toolCallId: 'p1', status: 'completed', content: [{ type: 'text', text: '后台子代理还在跑（sessionID: c9）' }] } } });
        backlogText(sid, 'b-msg', '已交给子代理');
        backlogText(sid, 'b-sum', backlogSummary);
      } else {
        say(sid, 'replayed history');
      }
      send({
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'init', description: 'guided setup' }]
          }
        }
      });
      return send({ id: msg.id, result: { configOptions: options() } });
    }
    case 'session/set_config_option': {
      if (LEGACY) return send({ id: msg.id, result: { configOptions: [] } });
      const known = new Set([...options().map((option) => option.id), 'mode', 'thinking', 'effort']);
      if (!known.has(msg.params.configId)) {
        return send({ id: msg.id, error: { code: -32602, message: `Unknown config option: ${msg.params.configId}` } });
      }
      if (msg.params.configId === 'mode') mode = msg.params.value;
      else if (msg.params.configId !== 'model') return send({ id: msg.id, result: { configOptions: options() } });
      else model = msg.params.value;
      return send({ id: msg.id, result: { configOptions: options() } });
    }
    case 'session/set_model':
      model = msg.params.modelId;
      return send({ id: msg.id, result: {} });
    case 'session/set_mode':
      mode = msg.params.modeId;
      return send({ id: msg.id, result: {} });
    case 'session/prompt': {
      turn += 1;
      const text = msg.params.prompt[0].text;
      // hub 会在用户文字前面加上下文：魔法词用「包含」判断
      const all = msg.params.prompt.map((block) => block.text ?? '').join('\n');
      if (all.includes('please-report-effective-model')) {
        say(msg.params.sessionId, `effective-model:${model}`);
        return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }
      if (EMPTY_ALL || all.includes('please-empty')) {
        process.stderr.write('Error: 401 Unauthorized from provider, api_key=sk-livesecret1234567890 Authorization: Bearer abcdefghijklmnop\n');
        return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }
      // 门控（e2e #269 排序）：见文件头 --gate-dir 说明。
      const gated = GATE_DIR ? all.match(/please-(hold|mark):([\w.-]+)/) : null;
      if (GATE_DIR && gated) {
        const [, how, key] = gated;
        const sessionId = msg.params.sessionId;
        // 追加而不是覆盖：同一个 key 进来两次会留两行，测试能看出来
        appendFileSync(join(GATE_DIR, `${how}-${key}.started`), `${Date.now()}\n`);
        if (how === 'mark') {
          say(sessionId, `marked:${key} 开跑`);
          return send({ id: msg.id, result: { stopReason: 'end_turn' } });
        }
        say(sessionId, `hold:${key} 开始`);
        const goFile = join(GATE_DIR, `hold-${key}.go`);
        const deadline = Date.now() + 120_000;
        const wait = () => {
          if (existsSync(goFile)) {
            say(sessionId, `hold:${key} 放行`);
            return send({ id: msg.id, result: { stopReason: 'end_turn' } });
          }
          if (Date.now() > deadline) {
            say(sessionId, `hold:${key} 等太久，自己结束`);
            return send({ id: msg.id, result: { stopReason: 'end_turn' } });
          }
          setTimeout(wait, 25);
        };
        return wait();
      }
      // please-delegate：用 session/new 下发的 HTTP MCP server 真的调 workspace.delegate
      // （args 从 prompt 里的 k=v 读；只在 --mcp-http 下生效）。
      if (MCP_HTTP && all.includes('please-delegate')) {
        const sessionId = msg.params.sessionId;
        const server = mcpServers.find((entry) => entry && entry.type === 'http' && typeof entry.url === 'string');
        const pick = (name) => new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(all)?.[1] ?? '';
        const args = {
          request_key: pick('key') || `mcp-${turn}`,
          task_id: pick('task'),
          repo_id: pick('repo'),
          base_branch: pick('base') || 'main',
          instructions: pick('instructions') || '请加一个文件',
          agent_id: pick('agent') || 'fakeacp'
        };
        try {
          if (!server) throw new Error('session/new 没有下发 HTTP MCP server');
          const list = await mcpCall(server, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
          const names = (list?.result?.tools ?? []).map((tool) => tool.name);
          const called = await mcpCall(server, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workspace.delegate', arguments: args } });
          const text = (called?.result?.content ?? []).map((block) => block.text ?? '').join(' ');
          say(sessionId, `delegate-tools:${names.join(',')};result:${text.slice(0, 300)}`);
        } catch (error) {
          say(sessionId, `delegate-error:${error.message}`);
        }
        return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }
      // please-project-create / please-project-worktree：项目会话 MCP 工具 lane。
      // 和 please-delegate 一样用 session/new 下发的 HTTP MCP server，但调的是 project.task.create /
      // project.worktree.start；把工具清单、isError 和响应原文一起打回事件流，供 e2e 精确断言。
      if (MCP_HTTP && (all.includes('please-project-create') || all.includes('please-project-worktree'))) {
        const sessionId = msg.params.sessionId;
        const server = mcpServers.find((entry) => entry && entry.type === 'http' && typeof entry.url === 'string');
        const pick = (name) => new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(all)?.[1] ?? '';
        const taskLane = all.includes('please-project-create');
        const action = taskLane ? 'task.create' : 'worktree.start';
        let names = [];
        let listError = null;
        let callError = null;
        try {
          if (!server) throw new Error('session/new 没有下发 HTTP MCP server');
          const list = await mcpCall(server, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
          names = (list?.result?.tools ?? []).map((tool) => tool.name);
          listError = list?.error ?? null;
          const args = taskLane
            ? {
                request_key: pick('key') || `project-task-${turn}`,
                title: pick('title') || '项目子任务',
                ...(pick('goal') ? { goal: pick('goal') } : {}),
                ...(pick('parent') ? { parent_task_id: pick('parent') } : {})
              }
            : {
                request_key: pick('key') || `project-worktree-${turn}`,
                task_id: pick('task'),
                repo_id: pick('repo'),
                base_branch: pick('base') || 'main',
                instructions: pick('instructions') || '请加一个文件',
                agent_id: pick('agent') || 'fakeacp',
                ...(pick('model') ? { model: pick('model') } : {})
              };
          const called = await mcpCall(server, {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: taskLane ? 'project_task_create' : 'project_worktree_start', arguments: args }
          });
          const text = (called?.result?.content ?? []).map((block) => block.text ?? '').join(' ').slice(0, 600);
          callError = called?.error ?? null;
          say(sessionId, `project-observation:${JSON.stringify({ action, names, listError, callError, isError: called?.result?.isError === true, text })}`);
        } catch (error) {
          say(sessionId, `project-observation:${JSON.stringify({ action, names, listError, callError, isError: true, text: String(error.message ?? error).slice(0, 600) })}`);
        }
        return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }
      // please-project-handoff / please-project-import：项目会话 MCP 的第二组工具。
      // 交接默认不传 wake（服务端按 false 处理）；候选引用只在三件套齐全时附带。
      if (MCP_HTTP && (all.includes('please-project-handoff') || all.includes('please-project-import'))) {
        const sessionId = msg.params.sessionId;
        const server = mcpServers.find((entry) => entry && entry.type === 'http' && typeof entry.url === 'string');
        const pick = (name) => new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(all)?.[1] ?? '';
        const handoffLane = all.includes('please-project-handoff');
        const action = handoffLane ? 'handoff' : 'candidate.import';
        let names = [];
        let listError = null;
        let callError = null;
        try {
          if (!server) throw new Error('session/new 没有下发 HTTP MCP server');
          const list = await mcpCall(server, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
          names = (list?.result?.tools ?? []).map((tool) => tool.name);
          listError = list?.error ?? null;
          const args = handoffLane
            ? {
                request_key: pick('key') || `project-handoff-${turn}`,
                target_session_id: pick('target'),
                body: pick('body') || 'handoff_body',
                ...(pick('wake') ? { wake: pick('wake') === 'true' } : {}),
                ...(pick('candidate_source') && pick('candidate_repo') && pick('candidate_sha')
                  ? {
                      candidate: {
                        source_session_id: pick('candidate_source'),
                        repo_id: pick('candidate_repo'),
                        sha: pick('candidate_sha')
                      }
                    }
                  : {})
              }
            : {
                request_key: pick('key') || `project-import-${turn}`,
                source_session_id: pick('source'),
                target_session_id: pick('target'),
                repo_id: pick('repo'),
                sha: pick('sha')
              };
          const called = await mcpCall(server, {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: handoffLane ? 'project_session_handoff' : 'project_candidate_import', arguments: args }
          });
          const text = (called?.result?.content ?? []).map((block) => block.text ?? '').join(' ').slice(0, 900);
          callError = called?.error ?? null;
          say(sessionId, `project-observation:${JSON.stringify({ action, names, listError, callError, isError: called?.result?.isError === true, text })}`);
        } catch (error) {
          say(sessionId, `project-observation:${JSON.stringify({ action, names, listError, callError, isError: true, text: String(error.message ?? error).slice(0, 900) })}`);
        }
        return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }
      // please-report：受限的 prepared 执行会话用 workspace.report 向派工协调会话回报。
      // 只发契约字段（request_key / body / sha），把工具清单、isError 和响应原文打回事件流。
      if (MCP_HTTP && all.includes('please-report')) {
        const sessionId = msg.params.sessionId;
        const server = mcpServers.find((entry) => entry && entry.type === 'http' && typeof entry.url === 'string');
        const pick = (name) => new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(all)?.[1] ?? '';
        let names = [];
        let listError = null;
        let callError = null;
        try {
          if (!server) throw new Error('session/new 没有下发 HTTP MCP server');
          const list = await mcpCall(server, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
          names = (list?.result?.tools ?? []).map((tool) => tool.name);
          listError = list?.error ?? null;
          const args = {
            request_key: pick('key') || `report-${turn}`,
            body: pick('body') || 'report_body',
            ...(pick('sha') ? { sha: pick('sha') } : {})
          };
          const called = await mcpCall(server, {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'workspace_report', arguments: args }
          });
          const text = (called?.result?.content ?? []).map((block) => block.text ?? '').join(' ').slice(0, 900);
          callError = called?.error ?? null;
          say(sessionId, `report-observation:${JSON.stringify({ action: 'report', names, listError, callError, isError: called?.result?.isError === true, text })}`);
        } catch (error) {
          say(sessionId, `report-observation:${JSON.stringify({ action: 'report', names, listError, callError, isError: true, text: String(error.message ?? error).slice(0, 900) })}`);
        }
        return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }
      // please-project-asset-*：项目资产工具 lane（阶段 3）。工具清单、isError 和响应原文一起
      // 打回事件流；replay=true 时用同一个参数连续调用两次，验证请求键幂等。
      if (MCP_HTTP && all.includes('please-project-asset-')) {
        const sessionId = msg.params.sessionId;
        const server = mcpServers.find((entry) => entry && entry.type === 'http' && typeof entry.url === 'string');
        const pick = (name) => new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(all)?.[1] ?? '';
        const listLane = all.includes('please-project-asset-list');
        const readLane = all.includes('please-project-asset-read');
        const createLane = all.includes('please-project-asset-create');
        const reviseLane = all.includes('please-project-asset-revise');
        const enableLane = all.includes('please-project-asset-enable');
        const action = listLane
          ? 'asset.list'
          : readLane
            ? 'asset.read'
            : createLane
              ? 'asset.create'
              : reviseLane
                ? 'asset.revise'
                : 'asset.set_enabled';
        const name = pick('name') || `e2e-asset-${turn}`;
        const body = pick('body') || 'version one';
        const files = [
          {
            path: 'SKILL.md',
            content: `---\nname: ${name}\ndescription: E2E project asset\n---\n${body}\n`
          }
        ];
        const args = listLane
          ? {
              ...(pick('kind') ? { kind: pick('kind') } : {}),
              ...(pick('include_disabled') ? { include_disabled: pick('include_disabled') === 'true' } : {}),
              ...(pick('limit') ? { limit: Number(pick('limit')) } : {})
            }
          : readLane
            ? {
                asset_id: pick('asset'),
                ...(pick('path') ? { path: pick('path') } : {})
              }
            : createLane
              ? { request_key: pick('key') || `project-asset-create-${turn}`, kind: pick('kind') || 'skill', name, files }
              : reviseLane
                ? { request_key: pick('key') || `project-asset-revise-${turn}`, asset_id: pick('asset'), files }
                : { request_key: pick('key') || `project-asset-enable-${turn}`, asset_id: pick('asset'), enabled: pick('enabled') === 'true' };
        const replay = pick('replay') === 'true';
        try {
          if (!server) throw new Error('session/new 没有下发 HTTP MCP server');
          const list = await mcpCall(server, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
          const names = (list?.result?.tools ?? []).map((tool) => tool.name);
          const listError = list?.error ?? null;
          for (let attempt = 0; attempt < (replay ? 2 : 1); attempt++) {
            const called = await mcpCall(server, {
              jsonrpc: '2.0',
              id: 2 + attempt,
              method: 'tools/call',
              params: { name: `project_asset_${action.slice('asset.'.length)}`, arguments: args }
            });
            const text = (called?.result?.content ?? []).map((block) => block.text ?? '').join(' ').slice(0, 1200);
            say(sessionId, `project-observation:${JSON.stringify({ action, names, listError, callError: called?.error ?? null, isError: called?.result?.isError === true, text })}`);
          }
        } catch (error) {
          say(sessionId, `project-observation:${JSON.stringify({ action, names: [], listError: null, callError: null, isError: true, text: String(error.message ?? error).slice(0, 1200) })}`);
        }
        return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }
      // please-write:<相对路径>=<一行内容>：在会话目录里追加一行（回合检查点 e2e 用）
      const writes = [...all.matchAll(/please-write:([\w./-]+)=(\S+)/g)];
      if (writes.length > 0) {
        for (const [, file, line] of writes) appendFileSync(join(cwd, file), `${line}\n`);
        say(msg.params.sessionId, `wrote ${writes.map((w) => w[1]).join(',')}`);
        return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }
      if (all.includes('please-history')) {
        say(msg.params.sessionId, `history:forked-at=${forkedAt ?? 'none'};briefed=${all.includes('交接') || all.includes('摘要') ? 'maybe' : 'no'}`);
        return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }
      if (CHILD && all.includes('please-child')) {
        const sessionId = msg.params.sessionId;
        const child = { rootSessionId: sessionId, childSessionId: 'c1', parentSessionId: sessionId, depth: 1, title: 'child task' };
        const status = (value) => send({ method: 'opencode/session/child_update', params: { ...child, type: 'status', status: value } });
        const update = (value) => send({ method: 'opencode/session/child_update', params: { ...child, type: 'update', update: value } });
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'p1', title: 'subagent', kind: 'other', rawInput: {} } } });
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'p1', status: 'in_progress', rawInput: { agent: 'explorer', description: 'child task', prompt: 'list', background: false } } } });
        status('created');
        status('running');
        update({ sessionUpdate: 'tool_call', toolCallId: 'c1:t1', title: 'child: shell', kind: 'other', rawInput: { command: 'ls' } });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child says hi' } });
        status('completed');
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'p1', status: 'completed', content: [{ type: 'text', text: '<subagent sessionID="c1" state="completed">done</subagent>' }] } } });
        say(sessionId, 'parent done');
        return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }
      // 「等我处理」e2e：显式提问工具 / 以问号结尾 / 这一轮 git commit
      const tool = (title, rawInput) => {
        const toolCallId = `t-${turn}-${title.length}`;
        send({ method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId, title, kind: 'other', rawInput } } });
        send({ method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' } } });
      };
      if (all.includes('please-asktool')) {
        tool('AskUserQuestion', { question: '用 A 还是 B' });
        say(msg.params.sessionId, '等你选。');
        return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }
      if (all.includes('please-question')) {
        say(msg.params.sessionId, '要我继续吗？');
        return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }
      if (all.includes('please-commit')) {
        tool('bash', { command: 'git commit -m "改好了"' });
        say(msg.params.sessionId, '提交好了。');
        return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }
      if (all.includes('please-refuse')) return send({ id: msg.id, result: { stopReason: 'refusal' } });
      // please-detach：把事件流（stdout）关掉，但进程继续活着、这一轮也不应答。
      // 用来验证「流关了 ≠ 进程退出」：适配器不能凭断流推 ended，更不能挂 deliveryId。
      if (all.includes('please-detach')) {
        process.stdout.end();
        setInterval(() => undefined, 1000);
        return;
      }
      if (all.includes('please-long')) {
        say(msg.params.sessionId, '写了一半');
        return send({ id: msg.id, result: { stopReason: 'max_tokens' } });
      }
      // please-late：先 end_turn（这一轮结束），再延迟推一条 update —— 用来验证回合结束后
      // 进程仍活着、后续 session/update 还能映射成事件（保活）。延迟要超过 prompt 收尾时
      // 等 stderr 的 200ms，才真的落在 ended 之后。
      if (all.includes('please-late')) {
        const lateSessionId = msg.params.sessionId;
        say(lateSessionId, 'late:先回一句');
        send({ id: msg.id, result: { stopReason: 'end_turn' } });
        setTimeout(() => say(lateSessionId, 'late:我还在'), 600);
        return;
      }
      // please-backlog：后台子代理还没跑完，父回合先 end_turn；总结要等之后 session/load 重放才看得到
      if (all.includes('please-backlog')) {
        const sessionId = msg.params.sessionId;
        backlogThought(sessionId, 'b-thought', '先看看');
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'p1', title: 'subagent', kind: 'other', rawInput: {} } } });
        send({
          method: 'opencode/session/child_update',
          params: { rootSessionId: sessionId, childSessionId: 'c9', parentSessionId: sessionId, depth: 1, title: 'bg task', type: 'status', status: 'running' }
        });
        backlogText(sessionId, 'b-msg', '已交给子代理');
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'p1', status: 'completed', content: [{ type: 'text', text: '后台子代理还在跑（sessionID: c9）' }] } } });
        send({ id: msg.id, result: { stopReason: 'end_turn' } });
        // 之后不会有任何 session/update —— 只有历史里多了一条总结
        setTimeout(() => {
          backlogSummary = '子代理已完成：child-done';
        }, 150);
        return;
      }
      if (text.includes('OK')) {
        say(msg.params.sessionId, 'OK');
        return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }
      say(msg.params.sessionId, `methods:${seen.join(',')}`);
      if (text !== 'ask') return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      pendingPrompt = msg.id;
      pendingPromptSession = msg.params.sessionId;
      return send({
        id: 99,
        method: 'session/request_permission',
        params: {
          sessionId: msg.params.sessionId,
          toolCall: { toolCallId: 't' },
          options: [
            { optionId: 'no', name: 'No', kind: 'reject_once' },
            { optionId: 'yes', name: 'Yes', kind: 'allow_once' }
          ]
        }
      });
    }
  }
});
