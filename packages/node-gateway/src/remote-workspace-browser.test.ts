import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRpcChannel, type RpcChannel } from '@agent-hub/contract';
import { unavailable } from '@agent-hub/domain';
import { createRemoteBrowsers } from './remote-workspace-browser.ts';
import { serveWorkerFiles } from './worker-fs-rpc.ts';
import { createWorkerFiles } from './worker-files.ts';

function pair() {
  const ends: RpcChannel[] = [];
  ends.push(createRpcChannel({ idPrefix: 'h', timeoutMs: 5000, send: (f) => (queueMicrotask(() => ends[1]!.receive(f)), true) }));
  ends.push(createRpcChannel({ idPrefix: 'w', timeoutMs: 5000, send: (f) => (queueMicrotask(() => ends[0]!.receive(f)), true) }));
  return { hub: ends[0]!, worker: ends[1]! };
}

test('远端浏览：files.* 过 RPC，WORKER_ROOTS 外的根被拒，变化经 files.changed 回来，掉线发 reset', async () => {
  const allowed = await realpath(await mkdtemp(join(tmpdir(), 'rwb-')));
  const other = await realpath(await mkdtemp(join(tmpdir(), 'rwb-other-')));
  try {
    const root = join(allowed, 'ws');
    await mkdir(join(root, 'src'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root });
    await writeFile(join(root, 'src/a.ts'), 'a');
    const { hub, worker } = pair();
    serveWorkerFiles(worker, createWorkerFiles({ roots: [allowed], enforced: true }));
    let online = true;
    const remote = createRemoteBrowsers({
      channelOf: () => (online ? hub : null),
      offline: () => ({ ok: false, error: unavailable('Worker「w」不在线') }),
      toDomain: (o) => (o.ok ? o : { ok: false, error: { code: o.error.code === 'invalid' ? 'invalid' : 'unavailable', message: o.error.message } })
    });
    remote.serve('w1', hub);
    const b = remote.browser('w1');
    const page = await b.list(root, 'src', { limit: 100 });
    assert.ok(page.ok, JSON.stringify(page));
    assert.equal(page.value.entries[0]?.name, 'a.ts');
    const read = await b.read(root, 'src/a.ts', 100);
    assert.ok(read.ok && new TextDecoder().decode(read.value.bytes) === 'a');
    const outside = await b.list(other, '', { limit: 100 });
    assert.equal(outside.ok, false);

    const notices: unknown[] = [];
    const w = await b.watch(root, ['src'], (n) => notices.push(n));
    assert.ok(w.ok);
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(join(root, 'src/b.ts'), 'b');
    for (let i = 0; i < 40 && notices.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(notices.length > 0);
    remote.workerGone('w1');
    assert.deepEqual(notices.at(-1), { paths: [], reset: true });
    w.value();
    online = false;
    const gone = await b.list(root, '', { limit: 10 });
    assert.equal(gone.ok, false);
  } finally {
    await rm(allowed, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});
