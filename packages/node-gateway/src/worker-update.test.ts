import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, serverToWorkerSchema } from '@agent-hub/contract';
import type { WorkerStatus } from '@agent-hub/domain';
import { createServerGateway } from './server-gateway.ts';
import { connectWorkerLink } from './worker-link.ts';
import { readBuildInfo } from './build-info.ts';
import { downloadHubBundle, fetchFailureReason, HUB_BUNDLE_REF, hubHttpFrom, runSelfUpdate, type CommandRunner, type UpdateReport } from './updater.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

async function harness() {
  const updates: string[] = [];
  const gateway = createServerGateway({
    token: null,
    onHello: () => {},
    onEvent: () => {},
    onAgentSession: () => {},
    onOptions: () => {},
    onStatus: () => {},
    onWorkerGone: () => {},
    onUpdateStatus: (_id, update) => void updates.push(update.state)
  });
  const server: Server = createServer();
  server.on('upgrade', (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stop = async () => {
    gateway.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  };
  return { gateway, url, updates, stop };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const one = (workers: WorkerStatus[]) => workers[0];

test('更新指令只带提交号：任何额外字段或非 40 位十六进制都解析不过', () => {
  assert.ok(serverToWorkerSchema.safeParse({ kind: 'update', commit: A }).success);
  assert.ok(!serverToWorkerSchema.safeParse({ kind: 'update', commit: 'main; rm -rf /' }).success);
  assert.ok(!serverToWorkerSchema.safeParse({ kind: 'update', commit: 'abc1234' }).success);
  const extra = serverToWorkerSchema.safeParse({ kind: 'update', commit: A, command: 'echo hi' });
  assert.ok(extra.success && !('command' in extra.data));
});

test('版本随 hello 上报；更新指令下发、进度回报，worker 重启后用目标版本 hello 即标记完成', async () => {
  const { gateway, url, updates, stop } = await harness();
  const seen: string[] = [];
  const link = connectWorkerLink({
    url,
    token: '',
    workerId: 'w1',
    label: 'x',
    origin: 'remote',
    reconnect: false,
    runtimes: [],
    build: { version: '1.0.0', commit: A, protocol: PROTOCOL_VERSION },
    onUpdate: async (commit, report) => {
      seen.push(commit);
      report({ state: 'updating', message: '拉取', logTail: '' });
      report({ state: 'succeeded', message: '已更新', logTail: '$ npm ci\nok' });
    }
  });
  await until(() => gateway.workers().length === 1);
  assert.equal(one(gateway.workers())?.build?.commit, A);
  assert.equal(gateway.requestUpdate('w1', B), true);
  assert.equal(one(gateway.workers())?.update?.state, 'updating');
  await until(() => updates.includes('succeeded'));
  assert.deepEqual(seen, [B]);
  assert.equal(one(gateway.workers())?.update?.logTail, '$ npm ci\nok');
  await link.close();
  await until(() => one(gateway.workers())?.state === 'offline');
  assert.equal(gateway.requestUpdate('w1', B), false, '离线的发不了');

  // 「重启」后带着新版本回来
  const again = connectWorkerLink({
    url,
    token: '',
    workerId: 'w1',
    label: 'x',
    origin: 'remote',
    reconnect: false,
    runtimes: [],
    build: { version: '1.0.0', commit: B, protocol: PROTOCOL_VERSION }
  });
  await until(() => one(gateway.workers())?.state === 'online');
  const status = one(gateway.workers());
  assert.equal(status?.build?.commit, B);
  assert.equal(status?.update?.state, 'succeeded');
  assert.match(status?.update?.message ?? '', /已重启到 bbbbbbb/);
  await again.close();
  await stop();
});

test('启动守卫回退后：旧版重连时补报 rolled_back（带坏提交和原因），hub 清掉更新目标，只报一次', async () => {
  const { gateway, url, updates, stop } = await harness();
  const first = connectWorkerLink({
    url, token: '', workerId: 'w1', label: 'x', origin: 'remote', reconnect: false, runtimes: [],
    build: { version: '1.0.0', commit: A, protocol: PROTOCOL_VERSION },
    onUpdate: async (_commit, report) => report({ state: 'succeeded', message: '已更新到 bbbbbbb，正在重启', logTail: '' })
  });
  await until(() => gateway.workers().length === 1);
  gateway.requestUpdate('w1', B);
  await until(() => updates.includes('succeeded'));
  await first.close();
  await until(() => one(gateway.workers())?.state === 'offline');

  let note: { failed: string; restored: string; reason: string } | null = { failed: B, restored: A, reason: 'Error: boom' };
  const { rollbackReport } = await import('./boot-marker.ts');
  const back = () =>
    connectWorkerLink({
      url, token: '', workerId: 'w1', label: 'x', origin: 'remote', reconnect: false, runtimes: [],
      build: { version: '1.0.0', commit: A, protocol: PROTOCOL_VERSION },
      pendingUpdateReport: () => (note ? { report: rollbackReport(note), done: () => void (note = null) } : null)
    });
  const again = back();
  await until(() => one(gateway.workers())?.update?.state === 'rolled_back');
  const status = one(gateway.workers());
  assert.equal(status?.build?.commit, A);
  assert.match(status?.update?.message ?? '', /新版本 bbbbbbb 没能正常启动，已自动回退到 aaaaaaa/);
  assert.equal(status?.update?.logTail, 'Error: boom');
  assert.equal(note, null, '报完就删记录');
  await again.close();
  await until(() => one(gateway.workers())?.state === 'offline');
  // 之后哪怕带着 B 重连，也不会被当成「更新成功」（目标已清掉）
  const later = connectWorkerLink({
    url, token: '', workerId: 'w1', label: 'x', origin: 'remote', reconnect: false, runtimes: [],
    build: { version: '1.0.0', commit: B, protocol: PROTOCOL_VERSION }
  });
  await until(() => one(gateway.workers())?.state === 'online');
  assert.equal(one(gateway.workers())?.update?.state, 'rolled_back');
  await later.close();
  await stop();
});

test('不支持远程更新的 worker 回 refused', async () => {
  const { gateway, url, stop } = await harness();
  const link = connectWorkerLink({ url, token: '', workerId: 'w1', label: 'x', reconnect: false, runtimes: [] });
  await until(() => gateway.workers().length === 1);
  gateway.requestUpdate('w1', B);
  await until(() => one(gateway.workers())?.update?.state === 'refused');
  await link.close();
  await stop();
});

test('协议版本不兼容：hub 以 4426 拒绝并说明原因，worker 打出原因后不再重连', async () => {
  const { gateway, url, stop } = await harness();
  const logs: string[] = [];
  let closed = false;
  const link = connectWorkerLink({
    url,
    token: '',
    workerId: 'w1',
    label: 'x',
    runtimes: [],
    initialBackoffMs: 10,
    build: { version: '9.0.0', commit: A, protocol: PROTOCOL_VERSION + 1 },
    onLog: (message) => logs.push(message),
    onClose: () => (closed = true)
  });
  await until(() => closed);
  assert.deepEqual(gateway.workers(), []);
  assert.ok(logs.some((line) => /协议版本不兼容.*update-worker\.sh.*不再重连/.test(line)), logs.join('\n'));
  await link.close();
  await stop();
});

// ---- updater：脚本化的假命令 ----

function fakeRunner(script: Record<string, { code: number; output: string }>, calls: string[]): CommandRunner {
  return async (command, args) => {
    const line = `${command} ${args.join(' ')}`;
    calls.push(line);
    const key = Object.keys(script).find((prefix) => line.startsWith(prefix));
    return key ? script[key]! : { code: 0, output: '' };
  };
}

test('updater：已是目标提交 → 无需更新、不重启、不碰 git fetch', async () => {
  const calls: string[] = [];
  const reports: UpdateReport[] = [];
  const changed = await runSelfUpdate({
    repoDir: '/x',
    commit: A,
    report: (r) => reports.push(r),
    run: fakeRunner({ 'git rev-parse': { code: 0, output: `${A}\n` } }, calls)
  });
  assert.equal(changed, false);
  assert.equal(reports.at(-1)?.state, 'succeeded');
  assert.match(reports.at(-1)?.message ?? '', /无需更新/);
  assert.deepEqual(calls, ['git rev-parse HEAD']);
});

test('updater：工作区有改动 → 拒绝；非法提交号 → 拒绝且不跑任何命令', async () => {
  const calls: string[] = [];
  const reports: UpdateReport[] = [];
  const run = fakeRunner(
    { 'git rev-parse': { code: 0, output: A }, 'git status': { code: 0, output: ' M apps/x.ts\n' } },
    calls
  );
  assert.equal(await runSelfUpdate({ repoDir: '/x', commit: B, report: (r) => reports.push(r), run }), false);
  assert.equal(reports.at(-1)?.state, 'refused');
  assert.ok(!calls.some((c) => c.startsWith('git fetch')));
  calls.length = 0;
  assert.equal(await runSelfUpdate({ repoDir: '/x', commit: '$(reboot)', report: (r) => reports.push(r), run }), false);
  assert.deepEqual(calls, []);
});

test('updater：npm ci 失败 → 回滚到原提交并重装，报 failed 带日志', async () => {
  const calls: string[] = [];
  const reports: UpdateReport[] = [];
  let ci = 0;
  const base = fakeRunner({ 'git rev-parse': { code: 0, output: A } }, calls);
  const run: CommandRunner = async (command, args, cwd) => {
    if (command === 'npm') {
      calls.push(`npm ${args.join(' ')}`);
      ci += 1;
      return ci === 1 ? { code: 1, output: 'npm ERR! boom' } : { code: 0, output: 'ok' };
    }
    return base(command, args, cwd);
  };
  assert.equal(await runSelfUpdate({ repoDir: '/x', commit: B, report: (r) => reports.push(r), run }), false);
  const last = reports.at(-1);
  assert.equal(last?.state, 'failed');
  assert.match(last?.message ?? '', /已回滚/);
  assert.match(last?.logTail ?? '', /npm ERR! boom/);
  assert.ok(calls.includes(`git merge --ff-only ${B}`));
  assert.ok(calls.includes(`git reset --hard ${A}`));
});

test('updater：真实 git 仓库里快进到目标提交并报成功', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-update-'));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
  try {
    const origin = join(root, 'origin');
    const clone = join(root, 'clone');
    execFileSync('git', ['init', '-q', '-b', 'master', origin]);
    await writeFile(join(origin, 'package.json'), '{"version":"1.2.3"}\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'one');
    execFileSync('git', ['clone', '-q', origin, clone]);
    await writeFile(join(origin, 'b.txt'), 'b\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'two');
    const target = git(origin, 'rev-parse', 'HEAD');
    assert.notEqual(readBuildInfo(clone).commit, target);
    assert.equal(readBuildInfo(clone).version, '1.2.3');
    const reports: UpdateReport[] = [];
    const changed = await runSelfUpdate({
      repoDir: clone,
      commit: target,
      report: (r) => reports.push(r),
      installArgs: ['--version']
    });
    assert.equal(changed, true, reports.map((r) => r.message).join(' / '));
    assert.equal(readBuildInfo(clone).commit, target);
    assert.equal(reports.at(-1)?.state, 'succeeded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('updater：git fetch 偶发失败会重试，成功就继续；一直失败报清楚原因', async () => {
  const outputs = [
    { code: 128, output: "fatal: unable to access 'https://github.com/x/y.git/': TLS connect error: error:0A000126:SSL routines\n" },
    { code: 0, output: '' }
  ];
  const calls: string[] = [];
  const reports: UpdateReport[] = [];
  const base = fakeRunner({ 'git rev-parse': { code: 0, output: `${A}\n` }, 'git status': { code: 0, output: '' } }, calls);
  const run: CommandRunner = async (command, args, cwd) =>
    command === 'git' && args[0] === 'fetch' ? (calls.push('git fetch'), outputs.shift() ?? { code: 0, output: '' }) : base(command, args, cwd);
  await runSelfUpdate({ repoDir: '/x', commit: B, report: (r) => reports.push(r), run, fetchRetryDelaysMs: [0, 0] });
  assert.equal(calls.filter((c) => c.startsWith('git fetch')).length, 2);
  assert.ok(reports.some((r) => /TLS 连接被中断.*第 2 次/.test(r.message)));
  assert.ok(calls.some((c) => c.startsWith('git cat-file')), '重试成功后照常往下走');

  calls.length = 0;
  reports.length = 0;
  const failing: CommandRunner = async (command, args, cwd) =>
    command === 'git' && args[0] === 'fetch'
      ? (calls.push('git fetch'), { code: 128, output: 'fatal: unable to access: Could not resolve host: github.com' })
      : base(command, args, cwd);
  assert.equal(await runSelfUpdate({ repoDir: '/x', commit: B, report: (r) => reports.push(r), run: failing, fetchRetryDelaysMs: [0, 0] }), false);
  assert.equal(calls.filter((c) => c.startsWith('git fetch')).length, 3);
  assert.equal(reports.at(-1)?.state, 'failed');
  assert.match(reports.at(-1)?.message ?? '', /失败 3 次（域名解析失败（DNS））/);
  assert.equal(fetchFailureReason('remote: Repository not found.'), '没有权限（认证失败或仓库不可见）');
  assert.ok(!fetchFailureReason("unable to access 'https://tok@github.com/'").includes('github'));
});

test('updater：先用 hub 的 bundle（origin 连不上也能更新）；bundle 拿不到才 git fetch origin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-update-bundle-'));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
  try {
    const origin = join(root, 'origin');
    const clone = join(root, 'clone');
    execFileSync('git', ['init', '-q', '-b', 'master', origin]);
    await writeFile(join(origin, 'package.json'), '{"version":"1.2.3"}\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'one');
    execFileSync('git', ['clone', '-q', origin, clone]);
    await writeFile(join(origin, 'b.txt'), 'b\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'two');
    const target = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'update-ref', HUB_BUNDLE_REF, target);
    const bundle = join(root, 'w.bundle');
    git(origin, 'bundle', 'create', bundle, HUB_BUNDLE_REF);
    // 「GitHub」不通
    git(clone, 'remote', 'set-url', 'origin', join(root, 'nowhere'));
    const reports: UpdateReport[] = [];
    const changed = await runSelfUpdate({ repoDir: clone, commit: target, report: (r) => reports.push(r), installArgs: ['--version'], fetchBundle: async () => bundle, fetchRetryDelaysMs: [0, 0] });
    assert.equal(changed, true, reports.map((r) => r.message).join(' / '));
    assert.equal(readBuildInfo(clone).commit, target);
    assert.ok(!reports.some((r) => /git fetch 失败/.test(r.message)), '没去碰 origin');

    // bundle 拿不到：退回 origin，origin 也不通就报 fetch 失败、什么都不改
    const reports2: UpdateReport[] = [];
    git(clone, 'reset', '-q', '--hard', 'HEAD~1');
    assert.equal(await runSelfUpdate({ repoDir: clone, commit: target, report: (r) => reports2.push(r), installArgs: ['--version'], fetchBundle: async () => null, fetchRetryDelaysMs: [0, 0] }), false);
    assert.match(reports2.at(-1)?.message ?? '', /git fetch 失败 3 次/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('downloadHubBundle：sha256 对上才落盘；hubHttpFrom 从 ws 地址推出 http', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-bundle-dl-'));
  const { createHash } = await import('node:crypto');
  const body = Buffer.from('bundle-bytes');
  const sum = createHash('sha256').update(body).digest('hex');
  const seen: string[] = [];
  const fake = (good: boolean) => (async (url: string | URL | Request) => {
    seen.push(String(url));
    return String(url).endsWith('.sha256') ? new Response(`${good ? sum : 'f'.repeat(64)}  x\n`) : new Response(body);
  }) as typeof fetch;
  try {
    const path = await downloadHubBundle({ hubHttp: 'http://hub:7878', commit: A, dir, fetch: fake(true) });
    assert.ok(path?.endsWith(`worker-${A}.bundle`));
    assert.equal(seen[0], `http://hub:7878/install/worker-${A}.bundle.sha256`);
    assert.equal(await downloadHubBundle({ hubHttp: 'http://hub:7878', commit: B, dir, fetch: fake(false) }), null);
    assert.equal(await downloadHubBundle({ hubHttp: 'http://hub:7878', commit: 'nope', dir, fetch: fake(true) }), null);
    assert.equal(hubHttpFrom('ws://8.8.8.8:17900/worker'), 'http://8.8.8.8:17900');
    assert.equal(hubHttpFrom('wss://hub.example/worker'), 'https://hub.example');
    assert.equal(hubHttpFrom('not a url'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
