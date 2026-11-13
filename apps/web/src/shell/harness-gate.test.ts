import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSelectMachine, startBlockReason, type GateWorker } from './harness-gate.ts';

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
