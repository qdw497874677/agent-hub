import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { createResourceProbe, parseMeminfo, parseNvidiaSmi } from './resource-probe.ts';

test('meminfo：用 MemAvailable，不用 MemFree', () => {
  const parsed = parseMeminfo('MemTotal:       16000000 kB\nMemFree:          100000 kB\nMemAvailable:    8000000 kB\nSwapTotal: 2000 kB\nSwapFree: 500 kB\n');
  assert.deepEqual(parsed, { total: 16000000 * 1024, available: 8000000 * 1024, swapUsed: 1500 * 1024 });
  assert.equal(parseMeminfo('garbage'), null);
});

test('nvidia-smi 输出解析：MiB 转字节，坏值为 null', () => {
  const gpus = parseNvidiaSmi('NVIDIA A10, 37, 24576, 1024\nTesla T4, [N/A], 15360, 0\n');
  assert.equal(gpus.length, 2);
  assert.deepEqual(gpus[0], { name: 'NVIDIA A10', utilPercent: 37, memTotal: 24576 * 1024 * 1024, memUsed: 1024 * 1024 * 1024 });
  assert.equal(gpus[1]!.utilPercent, null);
});

test('没有 nvidia-smi：不带 gpus 字段，也不再反复起进程', async () => {
  let calls = 0;
  const probe = createResourceProbe({ roots: [os.tmpdir()], runGpuQuery: async () => ((calls += 1), null) });
  const first = await probe.sample(new Map());
  await probe.sample(new Map());
  assert.equal('gpus' in first.machine, false);
  assert.equal(calls, 1);
  assert.equal(first.machine.cpuPercent, null, '第一次没有基准');
  assert.ok(first.machine.memTotal > 0 && first.machine.memAvailable > 0);
  assert.equal(first.machine.disks.length, 1);
});

test('有 GPU：按间隔复用，不每次都跑 nvidia-smi', async () => {
  let calls = 0;
  let clock = 0;
  const probe = createResourceProbe({ roots: [], now: () => clock, gpuIntervalMs: 60_000, runGpuQuery: async () => ((calls += 1), 'X, 5, 100, 10\n') });
  const a = await probe.sample(new Map());
  clock = 15_000;
  const b = await probe.sample(new Map());
  clock = 61_000;
  await probe.sample(new Map());
  assert.equal(a.machine.gpus?.[0]?.name, 'X');
  assert.equal(b.machine.gpus?.length, 1);
  assert.equal(calls, 2);
});

test('会话：按进程树汇总；坏目录 / 已退出的 pid 被跳过', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)']);
  try {
    await new Promise((resolve) => child.once('spawn', resolve));
    const probe = createResourceProbe({ roots: ['/definitely/not/here', os.tmpdir()], runGpuQuery: async () => null });
    const sample = await probe.sample(new Map([['s1', child.pid!], ['gone', 999_999_9]]));
    assert.equal(sample.sessions.length, 1);
    assert.equal(sample.sessions[0]!.sessionId, 's1');
    assert.ok(sample.sessions[0]!.rss > 0);
    assert.ok(sample.sessions[0]!.processes >= 1);
    assert.equal(sample.machine.disks.length, 1);
  } finally {
    child.kill();
  }
});
