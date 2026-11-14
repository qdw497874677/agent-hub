#!/usr/bin/env node
// 假 `codex app-server`：读 stdin 的 JSON-RPC 行，按脚本应答并推通知。
// 只实现适配器用到的方法；审批请求的 id 用 900+，客户端响应按 id 配对。
import readline from 'node:readline';

const state = {
  threadId: 'th_fake_1',
  turnSeq: 0,
  activeTurn: null,
  requestSeq: 900,
  pendingApprovals: new Map()
};

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

const now = () => Date.now();

function requestApproval(method, params) {
  const id = ++state.requestSeq;
  return new Promise((resolve) => {
    state.pendingApprovals.set(id, resolve);
    write({ jsonrpc: '2.0', id, method, params });
  });
}

function threadResult(params) {
  return {
    thread: { id: params.threadId ?? state.threadId, createdAt: now(), updatedAt: now(), turns: [] },
    model: params.model ?? 'gpt-5.1-codex',
    modelProvider: 'openai',
    cwd: params.cwd ?? process.cwd(),
    approvalPolicy: params.approvalPolicy ?? 'on-request',
    approvalsReviewer: 'user',
    sandbox: params.sandbox ?? 'workspace-write'
  };
}

function finishTurn(turnId, status) {
  state.activeTurn = null;
  notify('turn/completed', {
    threadId: state.threadId,
    turn: {
      id: turnId,
      items: [],
      status,
      ...(status === 'failed' ? { error: { message: '401 Unauthorized: invalid api key' } } : {})
    }
  });
  notify('thread/tokenUsage/updated', {
    threadId: state.threadId,
    turnId,
    tokenUsage: {
      last: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        totalTokens: 125
      },
      total: {
        inputTokens: 300,
        cachedInputTokens: 40,
        outputTokens: 60,
        reasoningOutputTokens: 15,
        totalTokens: 375
      },
      modelContextWindow: 1000
    }
  });
}

async function runTurn(turnId, text) {
  notify('turn/started', {
    threadId: state.threadId,
    turn: { id: turnId, items: [], status: 'inProgress' }
  });

  if (text.includes('fail')) {
    notify('error', {
      threadId: state.threadId,
      turnId,
      error: { message: '401 Unauthorized: invalid api key' },
      willRetry: false
    });
    finishTurn(turnId, 'failed');
    return;
  }

  if (text.includes('hang')) {
    const item = {
      type: 'commandExecution',
      id: 'item_hang',
      command: 'sleep 100',
      commandActions: [],
      cwd: process.cwd(),
      status: 'inProgress'
    };
    notify('item/started', { threadId: state.threadId, turnId, item, startedAtMs: now() });
    return;
  }

  if (text.includes('decline')) {
    const item = {
      type: 'fileChange',
      id: 'item_patch',
      changes: [{ path: 'notes.txt', kind: { type: 'update' }, diff: '+ hello' }],
      status: 'inProgress'
    };
    notify('item/started', { threadId: state.threadId, turnId, item, startedAtMs: now() });
    const result = await requestApproval('item/fileChange/requestApproval', {
      itemId: 'item_patch',
      startedAtMs: now(),
      threadId: state.threadId,
      turnId,
      reason: '要改 notes.txt'
    });
    const accepted = result?.decision === 'accept';
    notify('item/completed', {
      threadId: state.threadId,
      turnId,
      item: { ...item, status: accepted ? 'completed' : 'declined' },
      completedAtMs: now()
    });
    finishTurn(turnId, 'completed');
    return;
  }

  notify('item/reasoning/textDelta', {
    threadId: state.threadId,
    turnId,
    itemId: 'item_think',
    contentIndex: 0,
    delta: '先看看目录。'
  });
  notify('item/agentMessage/delta', {
    threadId: state.threadId,
    turnId,
    itemId: 'item_msg',
    delta: '我来看看。'
  });

  const command = 'ls -la';
  const item = {
    type: 'commandExecution',
    id: 'item_cmd',
    command,
    commandActions: [],
    cwd: process.cwd(),
    status: 'inProgress'
  };
  notify('item/started', { threadId: state.threadId, turnId, item, startedAtMs: now() });
  const result = await requestApproval('item/commandExecution/requestApproval', {
    itemId: 'item_cmd',
    startedAtMs: now(),
    threadId: state.threadId,
    turnId,
    command,
    cwd: process.cwd(),
    reason: '要跑 ls'
  });
  const accepted = result?.decision === 'accept';
  notify('item/completed', {
    threadId: state.threadId,
    turnId,
    item: {
      ...item,
      status: accepted ? 'completed' : 'declined',
      exitCode: accepted ? 0 : null,
      aggregatedOutput: accepted ? 'a.txt\nb.ts\n' : null,
      durationMs: 12
    },
    completedAtMs: now()
  });
  if (accepted) {
    notify('item/agentMessage/delta', {
      threadId: state.threadId,
      turnId,
      itemId: 'item_msg',
      delta: '目录里有 a.txt 和 b.ts。'
    });
  }
  finishTurn(turnId, 'completed');
}

function handleRequest(message) {
  const { id, method, params = {} } = message;
  switch (method) {
    case 'initialize':
      reply(id, { userAgent: 'fake-codex/0.168.0' });
      return;
    case 'thread/start':
      state.threadId = 'th_fake_1';
      reply(id, threadResult(params));
      return;
    case 'thread/resume':
      if (params.threadId === 'th_missing') {
        replyError(id, -32001, 'thread not found: no rollout for th_missing');
        return;
      }
      state.threadId = params.threadId;
      reply(id, threadResult(params));
      return;
    case 'model/list':
      reply(id, {
        data: [
          {
            id: 'gpt-5.1-codex',
            model: 'gpt-5.1-codex',
            displayName: 'GPT-5.1 Codex',
            description: 'fake',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: '' },
              { reasoningEffort: 'medium', description: '' },
              { reasoningEffort: 'high', description: '' }
            ],
            inputModalities: ['text']
          },
          {
            id: 'gpt-5.1-codex-mini',
            model: 'gpt-5.1-codex-mini',
            displayName: 'GPT-5.1 Codex mini',
            description: 'fake',
            hidden: false,
            isDefault: false,
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }],
            inputModalities: ['text']
          },
          {
            id: 'gpt-5.1-codex-hidden',
            model: 'gpt-5.1-codex-hidden',
            displayName: 'hidden',
            description: '',
            hidden: true,
            isDefault: false,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [],
            inputModalities: ['text']
          }
        ],
        nextCursor: null
      });
      return;
    case 'turn/start': {
      const turnId = `turn_${++state.turnSeq}`;
      state.activeTurn = turnId;
      reply(id, { turn: { id: turnId, items: [], status: 'inProgress' } });
      setImmediate(() => {
        runTurn(turnId, String(params.input?.[0]?.text ?? '')).catch((error) => {
          process.stderr.write(`fake turn failed: ${error?.message ?? error}\n`);
        });
      });
      return;
    }
    case 'turn/interrupt': {
      reply(id, {});
      if (state.activeTurn !== null) finishTurn(state.activeTurn, 'interrupted');
      return;
    }
    default:
      replyError(id, -32601, `fake app-server 没有 ${method}`);
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (line.trim() === '') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message.method === 'string') {
    handleRequest(message);
    return;
  }
  if (message.id !== undefined) {
    const resolve = state.pendingApprovals.get(message.id);
    if (resolve !== undefined) {
      state.pendingApprovals.delete(message.id);
      resolve(message.result);
    }
  }
});
lines.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
