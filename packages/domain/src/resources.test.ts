import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS, assessPressure, debouncePressure, initialDebounce, type ResourceSample } from './resources.ts';
import { placeSession, type WorkerStatus } from './worker.ts';

const GiB = 1024 ** 3;
const sample = (over: Partial<ResourceSample['machine']> = {}, at = 0): ResourceSample => ({
  at,
  machine: {
    cpuPercent: 10,
    cores: 4,
    load: [0.1, 0.1, 0.1],
    memTotal: 16 * GiB,
    memAvailable: 8 * GiB,
    swapUsed: 0,
    disks: [{ root: '/home', total: 100 * GiB, free: 50 * GiB }],
    uptimeSec: 100,
    ...over
  },
  sessions: []
});

test('资源充足 = ok，没有原因', () => {
  assert.deepEqual(assessPressure(sample()), { level: 'ok', reasons: [] });
});

test('内存：<15% warn，<5% full', () => {
  assert.equal(assessPressure(sample({ memAvailable: 2 * GiB })).level, 'warn');
  assert.equal(assessPressure(sample({ memAvailable: 0.5 * GiB })).level, 'full');
});

test('磁盘：比例或绝对值任一触发；full 排在 warn 前面', () => {
  assert.equal(assessPressure(sample({ disks: [{ root: '/', total: 40 * GiB, free: 4 * GiB }] })).level, 'warn');
  const p = assessPressure(sample({ memAvailable: 2 * GiB, disks: [{ root: '/', total: 100 * GiB, free: 0.5 * GiB }] }));
  assert.equal(p.level, 'full');
  assert.match(p.reasons[0]!, /磁盘/);
  assert.equal(p.reasons.length, 2);
});

test('CPU 只有持续 1 分钟 >90% 才 warn，一个尖峰不算', () => {
  const now = 120_000;
  assert.equal(assessPressure(sample({ cpuPercent: 99 }, now), []).level, 'ok');
  const history = [60_000, 75_000, 90_000, 105_000].map((at) => sample({ cpuPercent: 95 }, at));
  assert.equal(assessPressure(sample({ cpuPercent: 99 }, now), history).level, 'warn');
  const dip = [...history.slice(0, 2), sample({ cpuPercent: 40 }, 90_000), history[3]!];
  assert.equal(assessPressure(sample({ cpuPercent: 99 }, now), dip).level, 'ok');
});

test('防抖：连续 3 次才切换等级', () => {
  const warn = { level: 'warn' as const, reasons: ['x'] };
  let state = debouncePressure(initialDebounce, warn);
  assert.equal(state.current.level, 'ok');
  state = debouncePressure(state, warn);
  assert.equal(state.current.level, 'ok');
  state = debouncePressure(state, { level: 'ok', reasons: [] });
  state = debouncePressure(state, warn);
  state = debouncePressure(state, warn);
  assert.equal(state.current.level, 'ok');
  state = debouncePressure(state, warn);
  assert.equal(state.current.level, 'warn');
  assert.equal(DEFAULT_THRESHOLDS.debounceSamples, 3);
});

test('满了且开了拒绝开关的机器不被选中；点名它时报清楚原因', () => {
  const base = (id: string, refusing: boolean): WorkerStatus => ({
    workerId: id,
    label: id,
    origin: 'remote',
    state: 'online',
    resources: { sample: sample(), pressure: { level: refusing ? 'full' : 'ok', reasons: refusing ? ['内存只剩 100M'] : [] }, refusing, refuseWhenFull: refusing }
  });
  const auto = placeSession([base('a', true), base('b', false)], { agentId: 'pi', requested: null, projectWorker: null });
  assert.deepEqual(auto, { ok: true, value: 'b' });
  const pinned = placeSession([base('a', true)], { agentId: 'pi', requested: 'a', projectWorker: 'a' });
  assert.ok(!pinned.ok && /资源紧张/.test(pinned.error.message) && /内存/.test(pinned.error.message));
  const old: WorkerStatus = { workerId: 'c', label: 'c', origin: 'remote', state: 'online' };
  assert.equal(placeSession([old], { agentId: 'pi', requested: 'c', projectWorker: 'c' }).ok, true);
});
