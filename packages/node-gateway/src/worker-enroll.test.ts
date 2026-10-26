import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServerGateway } from './server-gateway.ts';
import { enrollOverLink } from './worker-enroll.ts';

test('接入握手：enroll 帧经 /worker 长连接换凭据；码不对 4401 带原因', async () => {
  const seen: { code: string; label: string }[] = [];
  const gateway = createServerGateway({
    token: 't0k',
    onHello: () => {},
    onEvent: () => {},
    onAgentSession: () => {},
    onOptions: () => {},
    onStatus: () => {},
    onWorkerGone: () => {},
    async enroll({ code, label }) {
      seen.push({ code, label });
      return code === 'ahw_pair_ok' ? { ok: true, workerId: 'w-new', credential: 'ahw_secret' } : { ok: false, reason: '接入码无效或已用过' };
    }
  });
  const http = createServer();
  http.on('upgrade', (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;

  assert.deepEqual(await enrollOverLink({ url, code: 'ahw_pair_ok', label: '书房' }), { ok: true, workerId: 'w-new', credential: 'ahw_secret' });
  const denied = await enrollOverLink({ url, code: 'ahw_pair_bad', label: '书房' });
  assert.equal(denied.ok, false);
  assert.match(!denied.ok ? denied.reason : '', /接入码无效/);
  assert.deepEqual(seen.map((s) => s.label), ['书房', '书房']);

  gateway.close();
  http.closeAllConnections?.();
  await new Promise((resolve) => http.close(resolve));
});
