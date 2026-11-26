import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createWorkdirTerminalHost } from './workdir-terminal.ts';
import type { PtyProcessLike, PtySpawnOptions } from './terminal.ts';

const id = () => `wdt_${randomUUID()}`;
function fixture(opts: { lingerMs?: number; fenceMax?: number; check?: (path: string) => Promise<string | null> } = {}) {
  const processes: Array<PtyProcessLike & { exit(code?: number): void; fail: boolean }> = [];
  const envs: Record<string, string>[] = [];
  const exits: string[] = [];
  const host = createWorkdirTerminalHost({ shell: '/bin/sh', check: opts.check ?? (async () => null), backpressure: () => 0,
    onData: () => {}, onExit: (_epoch, terminalId) => exits.push(terminalId), env: { HOME: '/home/test', SECRET: 'no' },
    ...opts,
    pty: { spawn(_file: string, _args: readonly string[], options: PtySpawnOptions) {
      envs.push(options.env);
      let onExit: (event: { exitCode: number }) => void = () => {};
      const pty = { pid: 1, fail: false, onData: () => ({ dispose() {} }), onExit: (cb: typeof onExit) => { onExit = cb; return { dispose() {} }; },
        write() {}, resize() {}, pause() {}, resume() {}, kill() { if (pty.fail) throw new Error('kill failed'); }, exit(code = 0) { onExit({ exitCode: code }); } };
      processes.push(pty); return pty;
    } }
  })!;
  return { host, processes, envs, exits };
}

test('close fences late create, retains kill failures until verified exit, and rejects old epoch', async () => {
  const { host, processes, envs, exits } = fixture();
  const cwd = await realpath('/tmp'); const terminalId = id(); const key = { terminalId, epoch: host.epoch };
  assert.deepEqual(await host.create({ ...key, cwd, workspaceId: 'workspace' }), { state: 'running' });
  assert.equal(envs[0]?.SECRET, undefined);
  processes[0]!.fail = true;
  assert.deepEqual(await host.close(key), { exited: false });
  assert.equal((await host.inventory()).terminals[0]?.state, 'closing');
  assert.deepEqual(await host.create({ ...key, cwd, workspaceId: 'workspace' }), { state: 'closing' });
  processes[0]!.exit();
  assert.deepEqual(exits, [terminalId]);
  assert.deepEqual(await host.create({ ...key, cwd, workspaceId: 'workspace' }), { state: 'ended' });
  await assert.rejects(host.close({ ...key, epoch: randomUUID() }), /stale/);
  const unknown = { terminalId: id(), epoch: host.epoch };
  assert.deepEqual(await host.close(unknown), { exited: true });
  assert.deepEqual(await host.create({ ...unknown, cwd, workspaceId: 'workspace' }), { state: 'ended' });
  assert.equal(processes.length, 1);
});

test('create validates canonical paths, serializes fencing and fails closed at fence capacity', async () => {
  const cwd = await realpath('/tmp');
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const { host, processes } = fixture({ fenceMax: 2, check: async () => { await blocked; return null; } });
  const key = { terminalId: id(), epoch: host.epoch };
  const create = host.create({ ...key, cwd, workspaceId: 'w' });
  const close = host.close(key); unblock();
  assert.equal((await create).state, 'running'); assert.equal((await close).exited, false);
  processes[0]!.exit();
  const second = { terminalId: id(), epoch: host.epoch };
  await host.close(second);
  await assert.rejects(host.close({ terminalId: id(), epoch: host.epoch }), /capacity/);
  assert.equal((await host.create({ ...second, cwd, workspaceId: 'w' })).state, 'ended');
  const other = fixture();
  await assert.rejects(other.host.create({ terminalId: id(), epoch: other.host.epoch, cwd: `${cwd}/.`, workspaceId: 'w' }), /canonical/);
});

test('unattached newly created shell has detach linger', async () => {
  const { host, processes } = fixture({ lingerMs: 10 });
  const key = { terminalId: id(), epoch: host.epoch };
  await host.create({ ...key, workspaceId: 'w', cwd: await realpath('/tmp') });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal((await host.inventory()).terminals[0]?.state, 'closing');
  processes[0]!.exit();
});
