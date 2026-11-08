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
