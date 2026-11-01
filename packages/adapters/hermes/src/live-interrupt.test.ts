import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SessionEvent, SessionId, StartSpec, TaskId } from '@agent-hub/domain';
import { createHermesRuntime } from './hermes-runtime.ts';

/**
 * 真 Hermes 中断：本机起一个新的 Hermes 网关（新 HERMES_HOME），模型是本地假的 OpenAI 兼容服务（慢慢吐字，不碰真模型、不用密钥）。
 * 发一轮 → 等吐出字 → 中断 → 期望这一轮落 stopped/interrupted 而不是 done，且网关还能接下一轮。
 * 默认跳过（CI 没装 Hermes）：HERMES_LIVE=1 才跑。
 */
test('真 Hermes：一轮中途中断', { skip: process.env['HERMES_LIVE'] !== '1', timeout: 180_000 }, async () => {
  let requests = 0;
  const model = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (process.env['HERMES_LIVE_DEBUG']) console.log('model', req.method, req.url, body.slice(0, 120));
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'slow-1', object: 'model' }] }));
        return;
      }
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
        return;
      }
      requests++;
      const stream = (JSON.parse(body || '{}') as { stream?: boolean }).stream !== false;
      if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: 'slow-1', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer);
        if (n++ >= Number(process.env['HERMES_LIVE_CHUNKS'] ?? 200)) {
          clearInterval(timer);
          res.end(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'slow-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
          return;
        }
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'slow-1', choices: [{ index: 0, delta: { content: `字${n} ` }, finish_reason: null }] })}\n\n`);
      }, 200);
      res.on('close', () => clearInterval(timer));
    });
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
  const root = await mkdtemp(join(tmpdir(), 'hermes-live-'));
  const workspaceRoot = join(root, 'ws');
  await mkdir(workspaceRoot);
  const logs: string[] = [];
  const runtime = createHermesRuntime({ root, log: (message) => logs.push(message), bootTimeoutMs: 90_000 });
  const spec = {
    sessionId: 'live-1' as SessionId,
    taskId: 't' as TaskId,
    workspaceRoot,
    resume: null,
    options: {},
    provider: { baseUrl, token: 'local-fake', models: [{ id: 'slow-1', name: 'slow-1' }] }
  } as unknown as StartSpec;
  const started = await runtime.start(spec);
  assert.ok(started.ok, `起不来：${started.ok ? '' : started.error.message}\n${logs.join('\n')}`);
  const session = started.value;
  const events = session.events()[Symbol.asyncIterator]();
  const next = async (until: (event: SessionEvent) => boolean, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const step = await Promise.race([events.next(), new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now()))]);
      if (!step || step.done) break;
      if (process.env['HERMES_LIVE_DEBUG']) console.log('event', JSON.stringify(step.value).slice(0, 200));
      if (until(step.value)) return step.value;
    }
    throw new Error('等不到事件');
  };
  try {
    assert.ok((await session.prompt({ text: '数到两百', parts: [] })).ok);
    await next((event) => event.kind === 'text', 60_000);
    const t0 = Date.now();
    await session.interrupt();
    const ended = await next((event) => event.kind === 'ended', 30_000);
    assert.equal(ended.kind, 'ended');
    assert.notEqual((ended as { outcome: string }).outcome, 'done', '中断后不该落 done');
    console.log(`中断 → ended ${(ended as { outcome: string }).outcome}，用时 ${Date.now() - t0}ms，模型请求 ${requests} 次`);
    // 网关还活着：能接下一轮
    const again = await session.prompt({ text: '再来', parts: [] });
    assert.ok(again.ok, `收到 ended 马上发下一轮被拒：${again.ok ? '' : again.error.message}`);
    await next((event) => event.kind === 'text', 60_000);
    await session.interrupt();
    await next((event) => event.kind === 'ended', 30_000);
  } finally {
    if (process.env['HERMES_LIVE_DEBUG']) console.log('logs', logs.join('\n'));
    await session.dispose();
    model.close();
  }
});
