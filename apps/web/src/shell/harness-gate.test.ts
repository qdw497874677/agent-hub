import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSelectMachine, startBlockReason, startHint, type GateWorker } from './harness-gate.ts';

const bare = (reason: string, providers?: readonly string[]): GateWorker => ({
  agentModels: [{ agentId: 'pi', readiness: { state: 'unavailable', reason }, ...(providers ? { providers } : {}) }]
});

test('没有原生模型、已有同协议 hub 模型：可以选机器，但空模型不能开始', () => {
  const worker = bare('未配置模型', ['openai-chat']);
  assert.equal(canSelectMachine(worker, 'pi', ['openai-chat']), true);
  assert.equal(canSelectMachine(worker, 'pi', []), false);
  assert.equal(canSelectMachine(worker, 'pi', ['anthropic']), false);
  assert.equal(startBlockReason(worker, 'pi', '', 'openai-chat'), '未配置模型');
  assert.equal(startBlockReason(worker, 'pi', 'hub-cn-glm-flash/glm-5.3-flash', 'openai-chat'), null);
  assert.equal(startBlockReason(worker, 'pi', 'hub-cn-glm-flash/glm-5.3-flash', 'anthropic'), '未配置模型');
  assert.equal(startBlockReason(worker, 'pi', 'opencode-go/deepseek-v4-flash', 'openai-chat'), '未配置模型');
});

test('未安装不因 hub 模型放行', () => {
  const worker = bare('未安装', ['openai-chat']);
  assert.equal(canSelectMachine(worker, 'pi', ['openai-chat']), false);
  assert.equal(startBlockReason(worker, 'pi', 'hub-cn-glm-flash/glm-5.3-flash', 'openai-chat'), '未安装');
});

test('「开始」的说明行：先说最挡路的那一个，能用时不说', () => {
  const ready = {
    agentId: 'pi',
    agentLabel: 'Pi',
    machine: 'remote-1',
    worker: bare('未登录', ['openai-chat']),
    model: 'pi-default',
    protocol: null,
    workspaceReady: true
  } as const;
  // 什么都没选：机器优先，其次 agent，再说运行时
  assert.equal(startHint({ ...ready, machine: null, workspaceReady: false }), '先选一台机器');
  assert.equal(startHint({ ...ready, agentId: '', workspaceReady: false }), '先选一个 agent');
  assert.equal(startHint({ ...ready, worker: undefined }), null);
  assert.equal(startHint(ready), '这台机器上的 Pi 用不了：未登录');
  // 没原因的不可用也不能念出半截冒号
  assert.equal(startHint({ ...ready, worker: bare('') }), '这台机器上的 Pi 用不了');
  // 机器和运行时都过了，才轮到工作空间
  const open = { ...ready, worker: undefined, workspaceReady: false };
  assert.equal(startHint(open), '先选一个工作空间');
  assert.equal(startHint({ ...open, workspaceNeedsPath: true }), '先选一个目录');
  // 都齐了：不渲染说明行
  assert.equal(startHint({ ...ready, worker: undefined }), null);
});
