import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PreviewLink } from '@agent-hub/domain';
import { createPreviewPrefix } from './preview-prefix.ts';
import type { PreviewChannel, PreviewOpenRequest, PreviewStream } from './preview-channel.ts';

const link = (over: Partial<PreviewLink> = {}): PreviewLink => ({
  id: 'pv_1' as PreviewLink['id'],
  sessionId: 's1' as PreviewLink['sessionId'],
  workerId: 'w1',
  port: 5173,
  hubPort: 17901,
  label: '端口 5173',
  source: 'manual',
  state: 'ready',
  createdAt: 1,
  lastSeenAt: 1,
  ...over
});

interface Harness {
  readonly opened: PreviewOpenRequest[];
  readonly closedCount: () => number;
  readonly channel: PreviewChannel;
}

const fakeChannel = (options: { status?: number; body?: string; offline?: boolean } = {}): Harness => {
  const opened: PreviewOpenRequest[] = [];
  const closed = { value: 0 };

  const channel: PreviewChannel = {
    handleUpgrade: () => undefined,
    hasWorker: () => true,
    streamCount: () => 0,
    close: () => undefined,
    async open(_workerId, request) {
      opened.push(request);
      const head: Array<(value: { status: number; statusText: string; headers: Array<[string, string]> }) => void> = [];
      const data: Array<(chunk: Buffer) => boolean | void> = [];
      const end: Array<() => void> = [];
      const fail: Array<(error: { status: number; message: string }) => void> = [];
      const stream: PreviewStream = {
        streamId: 'st1',
        onHead: (cb) => head.push(cb),
        onData: (cb) => data.push(cb),
        onEnd: (cb) => end.push(cb),
        onError: (cb) => fail.push(cb as never),
        write: () => undefined,
        endBody: () => undefined,
        ack: () => undefined,
        close: () => {
          closed.value += 1;
        }
      };
      setTimeout(() => {
        for (const cb of head) cb({ status: options.status ?? 200, statusText: 'OK', headers: [['content-type', 'text/html'], ['x-frame-options', 'DENY']] });
        setTimeout(() => {
          for (const cb of data) cb(Buffer.from(options.body ?? 'hi'));
          for (const cb of end) cb();
        }, 0);
      }, 0);
      return stream;
    }
  };
  return { opened, closedCount: () => closed.value, channel };
};

const prefix = (channel: PreviewChannel, extra: Partial<Parameters<typeof createPreviewPrefix>[0]> = {}) =>
  createPreviewPrefix({
    prefix: '/preview',
    resolve: async (id) => (id === 'pv_1' ? link() : null),
    authorize: async () => true,
    channel,
    ...extra
  });

test('前缀模式：路径透传到 worker 并透传响应体', async () => {
  const harness = fakeChannel({ body: 'hello' });
  const handler = prefix(harness.channel);
  const response = await handler.handle(new Request('http://hub:17900/preview/pv_1/assets/a.js?v=1'));
  assert.ok(response !== null);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'hello');
  assert.equal(harness.opened[0]?.port, 5173);
  assert.equal(harness.opened[0]?.path, '/assets/a.js?v=1');
  assert.ok(harness.opened[0]?.headers.some(([key, value]) => key === 'host' && value === '127.0.0.1:5173'));
  assert.equal(response.headers.get('x-frame-options'), null);
});

test('前缀模式：不命中前缀返回 null，未知链接 404，未授权 302 回登录页', async () => {
  const handler = prefix(fakeChannel().channel);
  assert.equal(await handler.handle(new Request('http://hub:17900/api/health')), null);

  const missing = await handler.handle(new Request('http://hub:17900/preview/pv_9/'));
  assert.equal(missing?.status, 404);

  const denied = prefix(fakeChannel().channel, { authorize: async () => false });
  const redirect = await denied.handle(new Request('http://hub:17900/preview/pv_1/x?y=1'));
  assert.equal(redirect?.status, 302);
  assert.match(redirect?.headers.get('location') ?? '', /^\/login\?next=/);
});
