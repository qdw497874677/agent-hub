// 最小的 ACP agent（ndjson over stdio），只给 acp-runtime 的测试用。
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
// --fork：像 claude-agent-acp 那样声明 session/fork、每条 assistant 消息带 messageId、认 _meta.jetbrains.air.fork（ADR 0028）
const FORK = process.argv.includes('--fork');
// --fork-fail：声明了 fork，但真分叉时报错（原生分叉失败的退路）
const FORK_FAIL = process.argv.includes('--fork-fail');
// --child：模拟 OpenCode 的 child session updates（子代理事件带 _meta['opencode/child-session']）
const CHILD = process.argv.includes('--child');
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
let cwd = process.cwd();

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    // 我们发出的 request_permission 的回答
    say('s1', `perm:${msg.result.outcome.optionId}`);
    send({ id: pendingPrompt, result: { stopReason: 'end_turn' } });
    return;
  }
  seen.push(msg.method + (msg.params?._meta ? JSON.stringify(msg.params._meta) : ''));
  switch (msg.method) {
    case 'initialize':
      return send({ id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'key', name: 'Key' }], ...(FORK ? { agentCapabilities: { sessionCapabilities: { fork: {} } } } : {}) } });
    case 'session/fork': {
      if (FORK_FAIL) return send({ id: msg.id, error: { code: -32603, message: 'fake fork failure' } });
      if (typeof msg.params?.cwd === 'string') cwd = msg.params.cwd;
      forkedAt = msg.params?._meta?.jetbrains?.air?.fork?.messageId ?? 'latest';
      return send({ id: msg.id, result: { sessionId: `f-${forkedAt}`, ...reported() } });
    }
    case 'authenticate':
      return send({ id: msg.id, result: {} });
    case 'session/new':
      if (typeof msg.params?.cwd === 'string') cwd = msg.params.cwd;
      if (LEGACY) model = 'custom:a';
      return send({ id: msg.id, result: { sessionId: 's1', ...reported() } });
    case 'session/load':
      say(msg.params.sessionId, 'replayed history');
      send({
        method: 'session/update',
        params: {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'init', description: 'guided setup' }]
          }
        }
      });
      return send({ id: msg.id, result: { configOptions: options() } });
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
      if (EMPTY_ALL || all.includes('please-empty')) {
        process.stderr.write('Error: 401 Unauthorized from provider, api_key=sk-livesecret1234567890 Authorization: Bearer abcdefghijklmnop\n');
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
      if (all.includes('please-long')) {
        say(msg.params.sessionId, '写了一半');
        return send({ id: msg.id, result: { stopReason: 'max_tokens' } });
      }
      if (text.includes('OK')) {
        say(msg.params.sessionId, 'OK');
        return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }
      say(msg.params.sessionId, `methods:${seen.join(',')}`);
      if (text !== 'ask') return send({ id: msg.id, result: { stopReason: 'end_turn' } });
      pendingPrompt = msg.id;
      return send({
        id: 99,
        method: 'session/request_permission',
        params: {
          sessionId: 's1',
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
