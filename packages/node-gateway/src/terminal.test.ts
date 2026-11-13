import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalHost, type PtyDisposable, type PtyExitEvent, type PtyModuleLike, type PtyProcessLike, type PtySpawnOptions, type TerminalHostOptions } from './terminal.ts';

/**
 * PTY 宿主的行为测试：用假 pty 注入，不依赖真的 node-pty（没装原生模块时测试照样跑）。
 * 覆盖：open 幂等 / cwd 越界 / 上限 / resize 校验 / linger / closeSession / 合批 / 背压 / 关闭解绑。
 */

let nextPid = 4000;

class FakePty implements PtyProcessLike {
  readonly pid = (nextPid += 1);
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  readonly kills: Array<string | undefined> = [];
  paused = false;
  resumes = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  onData(listener: (data: string) => void): PtyDisposable {
    this.dataListeners.add(listener);
    return { dispose: () => void this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable {
    this.exitListeners.add(listener);
    return { dispose: () => void this.exitListeners.delete(listener) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.kills.push(signal);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.resumes += 1;
  }

  emitData(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data);
  }

  emitExit(code: number, signal?: number): void {
    for (const listener of [...this.exitListeners]) listener(signal === undefined ? { exitCode: code } : { exitCode: code, signal });
  }

  listeners(): { data: number; exit: number } {
    return { data: this.dataListeners.size, exit: this.exitListeners.size };
  }
}

interface SpawnRecord {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: PtySpawnOptions;
  readonly pty: FakePty;
}

interface Harness {
  readonly host: NonNullable<ReturnType<typeof createTerminalHost>>;
  readonly spawns: SpawnRecord[];
  readonly data: Array<{ terminalId: string; bytes: Buffer }>;
  readonly exits: Array<{ terminalId: string; code: number; signal?: number }>;
  readonly logs: string[];
  readonly killed: Array<{ pid: number; signal: string }>;
  readonly descendantsOf: number[];
  backlog: number;
  readonly cwds: Map<string, string>;
  readonly rejections: Map<string, string>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function buildHarness(overrides: Partial<TerminalHostOptions> = {}): Harness {
  const spawns: SpawnRecord[] = [];
  const data: Harness['data'] = [];
  const exits: Harness['exits'] = [];
  const logs: string[] = [];
  const killed: Harness['killed'] = [];
  const descendantsOf: number[] = [];
  const cwds = new Map([
    ['s1', '/tmp/agent-hub-t1'],
    ['s2', '/tmp/agent-hub-t2']
  ]);
  const rejections = new Map<string, string>();
  const fake: PtyModuleLike = {
    spawn(file, args, options) {
      const pty = new FakePty();
      spawns.push({ file, args, options, pty });
      return pty;
    }
  };
  const state = {
    spawns,
    data,
    exits,
    logs,
    killed,
    descendantsOf,
    backlog: 0,
    cwds,
    rejections
  };
  const host = createTerminalHost({
    shell: '/bin/bash',
    pty: fake,
    tickMs: 8,
    check: async (path) => rejections.get(path) ?? null,
    backpressure: () => state.backlog,
    cwdOf: (sessionId) => cwds.get(sessionId),
    onData: (terminalId, chunk) => data.push({ terminalId, bytes: Buffer.from(chunk) }),
    onExit: (terminalId, code, signal) => exits.push(signal === undefined ? { terminalId, code } : { terminalId, code, signal }),
    descendants: async () => descendantsOf,
    killProcess: (pid, signal) => killed.push({ pid, signal }),
    log: (message) => logs.push(message),
    ...overrides
  });
  assert.ok(host, '有注入的 pty 时必须建出 host');
  // 用 Object.assign 而不是展开：测试改 `harness.backlog` 必须改到闭包读的那个对象。
  return Object.assign(state, { host });
}

test('open：同一终端重开只改尺寸，不重新 spawn', async () => {
  const harness = buildHarness();
  const first = await harness.host.open({ terminalId: 't1', sessionId: 's1', cols: 80, rows: 24 });
  assert.deepEqual(first, { cols: 80, rows: 24, reused: false });
  const again = await harness.host.open({ terminalId: 't1', sessionId: 's1', cols: 120, rows: 40 });
  assert.deepEqual(again, { cols: 120, rows: 40, reused: true });
  assert.equal(harness.spawns.length, 1);
  assert.deepEqual(harness.spawns[0]!.pty.resizes, [{ cols: 120, rows: 40 }]);
  assert.deepEqual(harness.host.list(), [{ terminalId: 't1', sessionId: 's1' }]);
});

test('spawn：登录 shell、会话 cwd、剥掉 worker 自己的环境变量', async () => {
  const harness = buildHarness({
    env: { HUB_TOKEN: 'secret', HUB_URL: 'ws://hub/worker', HUB_WORKER_CREDENTIAL: 'c', HUB_LOCAL_SECRET: 'l', HUB_PARENT_PID: '1', TERM: 'dumb', COLORTERM: '24bit', PATH: '/usr/bin', KEEP: 'yes' }
  });
  await harness.host.open({ terminalId: 't1', sessionId: 's1', cols: 100, rows: 30 });
  const spawn = harness.spawns[0]!;
  assert.equal(spawn.file, '/bin/bash');
  assert.deepEqual(spawn.args, ['-l']);
  assert.equal(spawn.options.name, 'xterm-256color');
  assert.equal(spawn.options.cwd, '/tmp/agent-hub-t1');
  assert.equal(spawn.options.cols, 100);
  assert.equal(spawn.options.rows, 30);
  assert.equal(spawn.options.env['TERM'], 'xterm-256color');
  assert.equal(spawn.options.env['COLORTERM'], 'truecolor');
  assert.equal(spawn.options.env['KEEP'], 'yes');
  assert.equal(spawn.options.env['PATH'], '/usr/bin');
  for (const secret of ['HUB_TOKEN', 'HUB_URL', 'HUB_WORKER_CREDENTIAL', 'HUB_LOCAL_SECRET', 'HUB_PARENT_PID']) {
    assert.equal(spawn.options.env[secret], undefined, `${secret} 不能漏给终端里的 shell`);
  }
});

test('open：会话不在这台机器上 / cwd 不在允许范围都报错', async () => {
  const harness = buildHarness();
  await assert.rejects(harness.host.open({ terminalId: 't1', sessionId: 'nope', cols: 80, rows: 24 }), /会话不在这台机器上运行/);
  harness.rejections.set('/tmp/agent-hub-t2', '不在 WORKER_ROOTS 里');
  await assert.rejects(harness.host.open({ terminalId: 't2', sessionId: 's2', cols: 80, rows: 24 }), /目录不在允许的范围内/);
  assert.equal(harness.spawns.length, 0);
});

test('open：hub 给了 cwd 就用它——会话已结束、本进程查不到这条会话时也能开', async () => {
  const harness = buildHarness();
  const opened = await harness.host.open({ terminalId: 't1', sessionId: 'done-session', cols: 80, rows: 24, cwd: '/tmp/agent-hub-t1' });
  assert.deepEqual(opened, { cols: 80, rows: 24, reused: false });
  assert.equal(harness.spawns[0]!.options.cwd, '/tmp/agent-hub-t1');
  harness.rejections.set('/tmp/agent-hub-t9', '不在 WORKER_ROOTS 里');
  await assert.rejects(
    harness.host.open({ terminalId: 't2', sessionId: 'done-2', cols: 80, rows: 24, cwd: '/tmp/agent-hub-t9' }),
    /目录不在允许的范围内/
  );
});

test('open：超过上限拒绝，关掉一个就又能开', async () => {
  const harness = buildHarness({ max: 2 });
  harness.cwds.set('s3', '/tmp/agent-hub-t3');
  await harness.host.open({ terminalId: 't1', sessionId: 's1', cols: 80, rows: 24 });
  await harness.host.open({ terminalId: 't2', sessionId: 's2', cols: 80, rows: 24 });
  await assert.rejects(harness.host.open({ terminalId: 't3', sessionId: 's3', cols: 80, rows: 24 }), /上限/);
  await harness.host.close('t1');
  const third = await harness.host.open({ terminalId: 't3', sessionId: 's1', cols: 80, rows: 24 });
  assert.equal(third.reused, false);
  assert.equal(harness.spawns.length, 3);
});

test('open：同一条会话只允许一个终端', async () => {
  const harness = buildHarness();
  await harness.host.open({ terminalId: 't1', sessionId: 's1', cols: 80, rows: 24 });
  await assert.rejects(harness.host.open({ terminalId: 't2', sessionId: 's1', cols: 80, rows: 24 }), /已经有一个终端/);
  assert.equal(harness.spawns.length, 1);
});

test('resize：非法尺寸和未知终端都拒绝', async () => {
  const harness = buildHarness();
  await harness.host.open({ terminalId: 't1', sessionId: 's1', cols: 80, rows: 24 });
  await assert.rejects(harness.host.resize('t1', 0, 24), /尺寸不合法/);
  await assert.rejects(harness.host.resize('t1', 1001, 24), /尺寸不合法/);
  await assert.rejects(harness.host.resize('t1', 80.5, 24), /尺寸不合法/);
  await assert.rejects(harness.host.resize('missing', 80, 24), /终端不存在/);
  assert.deepEqual(await harness.host.resize('t1', 132, 43), { ok: true });
  assert.deepEqual(harness.spawns[0]!.pty.resizes, [{ cols: 132, rows: 43 }]);
});

test('write：输入写进 stdin，未知终端返回 false', async () => {
  const harness = buildHarness();
  await harness.host.open({ terminalId: 't1', sessionId: 's1', cols: 80, rows: 24 });
  assert.equal(harness.host.write('t1', Buffer.from('ls\r')), true);
  assert.deepEqual(harness.spawns[0]!.pty.writes, ['ls\r']);
  assert.equal(harness.host.write('nope', Buffer.from('x')), false);
});

test('输出按 tick 合批，单帧不超过 64 KB', async () => {
  const harness = buildHarness({ tickMs: 10 });
  await harness.host.open({ terminalId: 't1', sessionId: 's1', cols: 80, rows: 24 });
  const pty = harness.spawns[0]!.pty;
  pty.emitData('hel');
  pty.emitData('lo');
  pty.emitData(' 世界');
  await sleep(40);
  assert.equal(harness.data.length, 1, '一个 tick 的多次输出应该合成一帧');
  assert.equal(harness.data[0]!.bytes.toString('utf8'), 'hello 世界');

  harness.data.length = 0;
  const big = 'x'.repeat(200_000);
  pty.emitData(big);
  await sleep(80);
  const total = harness.data.reduce((sum, frame) => sum + frame.bytes.length, 0);
  assert.equal(total, big.length);
  for (const frame of harness.data) assert.ok(frame.bytes.length <= 64 * 1024, `单帧 ${frame.bytes.length} 字节超限`);
  assert.ok(harness.data.length >= 4, '200 KB 至少要拆成 4 帧');
  assert.equal(Buffer.concat(harness.data.map((frame) => frame.bytes)).toString('utf8'), big);
});

test('背压：积压超过 4 MB 暂停读取，降到 512 KB 以下恢复', async () => {
  const harness = buildHarness({ tickMs: 5, pollMs: 10 });
  await harness.host.open({ terminalId: 't1', sessionId: 's1', cols: 80, rows: 24 });
  const pty = harness.spawns[0]!.pty;
  harness.backlog = 5 * 1024 * 1024;
  pty.emitData('blocked');
  await sleep(40);
  assert.equal(pty.paused, true);
  assert.equal(harness.data.length, 0);

  harness.backlog = 0;
  await sleep(80);
  assert.equal(pty.paused, false);
  assert.equal(pty.resumes, 1);
  assert.equal(Buffer.concat(harness.data.map((frame) => frame.bytes)).toString('utf8'), 'blocked');
});

test('linger：浏览器断开后到期回收，重连会重新计时', async () => {
  const harness = buildHarness({ lingerMs: 100, tickMs: 5 });
  await harness.host.open({ terminalId: 't1', sessionId: 's1', cols: 80, rows: 24 });
  harness.host.detach('t1');
  await sleep(20);
  // 重连（同 id 再 open）：计时器必须清掉，否则刚接上就被回收
  assert.equal((await harness.host.open({ terminalId: 't1', sessionId: 's1', cols: 90, rows: 30 })).reused, true);
  await sleep(60);
  assert.deepEqual(harness.host.list(), [{ terminalId: 't1', sessionId: 's1' }]);

  harness.host.detach('t1');
  await sleep(200);
  assert.deepEqual(harness.host.list(), []);
  assert.equal(harness.spawns[0]!.pty.kills.length, 1);
  assert.deepEqual(harness.exits, [{ terminalId: 't1', code: 0 }], '空闲回收要报给 hub');
});

test('closeSession：只收这条会话的终端，残留进程组一并清掉', async () => {
  const harness = buildHarness();
  harness.descendantsOf.push(9001, 9002);
  await harness.host.open({ terminalId: 't1', sessionId: 's1', cols: 80, rows: 24 });
  await harness.host.open({ terminalId: 't3', sessionId: 's2', cols: 80, rows: 24 });
  const first = harness.spawns[0]!.pty;
  const other = harness.spawns[1]!.pty;
  await harness.host.closeSession('s1');
  assert.deepEqual(harness.host.list(), [{ terminalId: 't3', sessionId: 's2' }]);
  assert.equal(first.kills.length, 1);
  assert.equal(other.kills.length, 0);
  assert.deepEqual(first.listeners(), { data: 0, exit: 0 }, '关闭后必须解绑，避免重复回调');
  // 兜底杀残留前台进程（瞎 pid 也不该抛）
  assert.deepEqual(harness.killed.map((entry) => entry.signal), ['SIGKILL', 'SIGKILL']);
});

test('close：解绑后 pty 自己再报退出不会重复回调；disposeAll 收掉全部', async () => {
  const harness = buildHarness();
  await harness.host.open({ terminalId: 't1', sessionId: 's1', cols: 80, rows: 24 });
  await harness.host.open({ terminalId: 't2', sessionId: 's2', cols: 80, rows: 24 });
  await harness.host.close('t1');
  harness.spawns[0]!.pty.emitExit(0);
  assert.deepEqual(harness.exits, []);
  await harness.host.disposeAll();
  assert.deepEqual(harness.host.list(), []);
  assert.equal(harness.spawns[1]!.pty.kills.length, 1);
});

test('pty 正常退出：先把没发完的输出冲掉，再报退出', async () => {
  const harness = buildHarness({ tickMs: 50 });
  await harness.host.open({ terminalId: 't1', sessionId: 's1', cols: 80, rows: 24 });
  const pty = harness.spawns[0]!.pty;
  pty.emitData('bye\n');
  pty.emitExit(3, 15);
  assert.equal(Buffer.concat(harness.data.map((frame) => frame.bytes)).toString('utf8'), 'bye\n');
  assert.deepEqual(harness.exits, [{ terminalId: 't1', code: 3, signal: 15 }]);
  assert.deepEqual(harness.host.list(), []);
});

test('切帧不会切坏多字节字符：跨 64 KB 边界的汉字整体留到下一帧', async () => {
  const harness = buildHarness({ tickMs: 5 });
  await harness.host.open({ terminalId: 't1', sessionId: 's1', cols: 80, rows: 24 });
  const pty = harness.spawns[0]!.pty;
  const text = `${'a'.repeat(64 * 1024 - 1)}界b`;
  pty.emitData(text);
  await sleep(60);
  const frames = harness.data.map((frame) => frame.bytes);
  assert.ok(frames.length >= 2);
  assert.equal(frames[0]!.length, 64 * 1024 - 1, '第一个汉字的前两个字节不能单独成帧');
  assert.equal(Buffer.concat(frames).toString('utf8'), text);
});

test('node-pty 加载不出来：host 还在，open 报不可用（不拖垮 worker 启动）', async () => {
  const data: Array<{ terminalId: string; bytes: Buffer }> = [];
  const host = createTerminalHost({
    shell: '/bin/bash',
    load: async () => null,
    check: async () => null,
    backpressure: () => 0,
    cwdOf: () => '/tmp/agent-hub-t1',
    onData: (terminalId, chunk) => data.push({ terminalId, bytes: Buffer.from(chunk) }),
    onExit: () => undefined,
    log: () => undefined
  });
  assert.ok(host, '加载失败只影响终端功能，host 本身要能建');
  await assert.rejects(host.open({ terminalId: 't1', sessionId: 's1', cols: 80, rows: 24 }), /终端不可用/);
  assert.deepEqual(host.list(), []);
  assert.deepEqual(data, []);
});
