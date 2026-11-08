import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderProtocol } from './provider.ts';
import { MCP_ADAPTER_MISSING, checkModelOn, harnessUnavailableReason, placeSession, withAssetNeeds, type WorkerStatus } from './worker.ts';

const worker = (workerId: string): WorkerStatus => ({
  workerId,
  label: workerId,
  origin: 'remote',
  state: 'online',
  agentIds: ['pi', 'grok'],
  agentModels: [
    { agentId: 'pi', models: [], defaultModel: '', readiness: { state: 'ready', lacks: ['mcp-adapter'] } },
    { agentId: 'grok', models: [], defaultModel: '', readiness: { state: 'ready' } }
  ]
});

test('就绪按资产收紧：装了 MCP 资产的机器上缺适配器的 Pi 不可用；没装 MCP 资产的机器不受影响', () => {
  const [withMcp, plain] = withAssetNeeds([worker('a'), worker('b')], new Set(['a']));
  assert.ok(withMcp && plain);
  assert.equal(harnessUnavailableReason(withMcp, 'pi'), MCP_ADAPTER_MISSING);
  assert.equal(harnessUnavailableReason(withMcp, 'grok'), null);
  assert.equal(harnessUnavailableReason(plain, 'pi'), null);
  const placed = placeSession([withMcp], { agentId: 'pi', requested: 'a', projectWorker: 'a' });
  assert.equal(placed.ok, false);
  assert.ok(!placed.ok && placed.error.message.includes(MCP_ADAPTER_MISSING));
});

const barePi = (reason: string, providers?: readonly ProviderProtocol[]): WorkerStatus => ({
  workerId: 'local',
  label: '本机',
  origin: 'local',
  state: 'online',
  agentIds: ['pi'],
  agentModels: [{ agentId: 'pi', models: [], defaultModel: '', readiness: { state: 'unavailable', reason }, ...(providers ? { providers } : {}) }]
});

test('没有原生模型、但选了 hub 模型且 agent 认这种协议：可以落点；缺运行时、协议不对、没选 hub 模型仍然拒绝', () => {
  const noNative = barePi('未配置模型', ['openai-chat']);
  const placed = placeSession([noNative], { agentId: 'pi', requested: 'local', projectWorker: 'local', model: 'hub-cn-glm-flash/glm-5.3-flash' });
  assert.equal(placed.ok, true);
  assert.equal(checkModelOn([noNative], 'local', 'pi', 'hub-cn-glm-flash/glm-5.3-flash', 'openai-chat').ok, true);
  const blank = placeSession([noNative], { agentId: 'pi', requested: 'local', projectWorker: 'local', model: '' });
  assert.equal(blank.ok, false);
  assert.ok(!blank.ok && blank.error.message.includes('未配置模型'));
  const missing = barePi('未安装', ['openai-chat']);
  const gone = placeSession([missing], { agentId: 'pi', requested: 'local', projectWorker: 'local', model: 'hub-cn-glm-flash/glm-5.3-flash' });
  assert.equal(gone.ok, false);
  assert.ok(!gone.ok && gone.error.message.includes('未安装'));
  const wrong = checkModelOn([noNative], 'local', 'pi', 'hub-cn-glm-flash/glm-5.3-flash', 'anthropic');
  assert.equal(wrong.ok, false);
  assert.ok(!wrong.ok && wrong.error.message.includes('anthropic'));
  const noHub = barePi('未配置模型');
  assert.equal(placeSession([noHub], { agentId: 'pi', requested: 'local', projectWorker: 'local', model: 'hub-cn-glm-flash/glm-5.3-flash' }).ok, false);
});
