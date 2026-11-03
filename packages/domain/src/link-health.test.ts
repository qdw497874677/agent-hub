import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HEARTBEAT, initialLink, linkIsDead, reconnectDelay, reduceLink, workerWatchdogMs } from './link-health.ts';

{
  const connected = reduceLink(initialLink(0), { type: 'connected' }, 100);

  test('连上先是 syncing，第一次回声回来才 live', () => {
    assert.equal(connected.state, 'syncing');
    const live = reduceLink(connected, { type: 'echo', rttMs: 12 }, 200);
    assert.partialDeepStrictEqual(live, { state: 'live', rttMs: 12, since: 200, connectedAt: 100 });
  });

  test('老 Worker 不认 link.echo 也算同步完成', () => {
    assert.equal(reduceLink(connected, { type: 'echo', rttMs: null }, 200).state, 'live');
  });

  test('漏一次 pong 降级，漏满上限判死，收到 pong 恢复', () => {
    const live = reduceLink(connected, { type: 'echo', rttMs: 5 }, 200);
    const one = reduceLink(live, { type: 'missed' }, 300);
    assert.equal(one.state, 'degraded');
    assert.equal(linkIsDead(one), false);
    assert.equal(linkIsDead(reduceLink(one, { type: 'missed' }, 400)), true);
    assert.partialDeepStrictEqual(reduceLink(one, { type: 'pong' }, 350), { state: 'live', since: 350 });
  });

  test('回声超时或太慢就降级', () => {
    const live = reduceLink(connected, { type: 'echo', rttMs: 5 }, 200);
    assert.equal(reduceLink(live, { type: 'echo_failed' }, 300).state, 'degraded');
    assert.equal(reduceLink(live, { type: 'echo', rttMs: DEFAULT_HEARTBEAT.echoTimeoutMs + 1 }, 300).state, 'degraded');
  });

  test('断开 / 被拒之后心跳事件不再改状态', () => {
    const gone = reduceLink(connected, { type: 'closed', rejected: false }, 500);
    assert.equal(gone.state, 'disconnected');
    assert.equal(reduceLink(gone, { type: 'pong' }, 600), gone);
    assert.equal(reduceLink(connected, { type: 'closed', rejected: true }, 500).state, 'rejected');
  });

  test('Worker 看门狗比 hub 判死多一个间隔；退避封顶 60 秒', () => {
    assert.equal(workerWatchdogMs(DEFAULT_HEARTBEAT), 30_000);
    assert.equal(reconnectDelay(0, 0.5), 500);
    assert.equal(reconnectDelay(20, 1), 72_000);
    assert.equal(reconnectDelay(20, 0), 48_000);
  });
}
