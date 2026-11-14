import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { unavailable, type WorkspaceFilesService } from '@agent-hub/domain';
import { installFilesRoutes } from './files-routes.ts';

/** 只实现这一条路由会调到的方法。其余方法不会被碰到。 */
function appReturning(message: string) {
  const app = new Hono();
  const files = {
    changes: async () => ({ ok: false as const, error: unavailable(message) })
  } as unknown as WorkspaceFilesService;
  installFilesRoutes(app, files, () => null);
  return app;
}

test('worker 不在线时 git/changes 是 503，正文保留不在线，没有 files', async () => {
  const res = await appReturning('Worker「e2e」不在线').request('/api/sessions/s1/git/changes?base=session');
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error?: { code?: string; message?: string }; files?: unknown };
  assert.equal(body.error?.code, 'unavailable');
  assert.equal(body.error?.message, 'Worker「e2e」不在线');
  assert.equal(body.files, undefined);
});

test('超时和通道未就绪也是 503，路由不改写成离线，也不回 200', async () => {
  for (const message of ['Worker「e2e」没有及时回复改动列表', 'worker 通道尚未就绪']) {
    const res = await appReturning(message).request('/api/sessions/s1/git/changes?base=session');
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: { code?: string; message?: string }; files?: unknown };
    assert.equal(body.error?.code, 'unavailable');
    assert.equal(body.error?.message, message);
    assert.equal(body.files, undefined);
  }
});

test('?member= 透传到文件 / git 用例（单仓库会话不带也照常）', async () => {
  const seen: Array<{ fn: string; args: unknown[] }> = [];
  const record = (fn: string, value: unknown) => async (...args: unknown[]) => {
    seen.push({ fn, args });
    return { ok: true as const, value };
  };
  const files = {
    context: record('context', {}),
    list: record('list', { path: '', entries: [], truncated: false, isGit: true }),
    read: record('read', { path: 'a.ts', size: 0, modifiedAt: 0, binary: false, truncated: false, bytes: new Uint8Array([65]) }),
    download: record('download', { path: 'a.ts', size: 0, modifiedAt: 0, binary: false, truncated: false, bytes: new Uint8Array([65]) }),
    find: record('find', ['a.ts']),
    changes: record('changes', { base: 'session', commit: null, target: null, turn: null, files: [] }),
    diff: record('diff', { path: 'a.ts', patch: '', truncated: false, binary: false })
  } as unknown as WorkspaceFilesService;
  const app = new Hono();
  installFilesRoutes(app, files, () => null);

  const urls = [
    ['context', '/api/sessions/s1/files/context?member=ws_web'],
    ['list', '/api/sessions/s1/files?path=src&member=ws_web'],
    ['read', '/api/sessions/s1/files/content?path=a.ts&member=ws_web'],
    ['download', '/api/sessions/s1/files/download?path=a.ts&member=ws_web'],
    ['find', '/api/sessions/s1/files/find?q=a&member=ws_web'],
    ['changes', '/api/sessions/s1/git/changes?base=session&member=ws_web'],
    ['diff', '/api/sessions/s1/git/diff?path=a.ts&base=head&member=ws_web']
  ] as const;
  for (const [fn, url] of urls) {
    const res = await app.request(url);
    assert.equal(res.status, 200, `${fn}: ${url}`);
    const call = seen.find((item) => item.fn === fn);
    assert.ok(call, fn);
    assert.equal(call.args.at(-1), 'ws_web', `${fn} 的 member`);
  }

  // 不给 member：传 undefined（单仓库会话行为不变）。
  seen.length = 0;
  await app.request('/api/sessions/s1/files?path=src');
  assert.equal(seen[0]?.args.at(-1), undefined);
});
