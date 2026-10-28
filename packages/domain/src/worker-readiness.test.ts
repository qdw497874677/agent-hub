import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_ADAPTER_MISSING, harnessUnavailableReason, placeSession, withAssetNeeds, type WorkerStatus } from './worker.ts';

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
