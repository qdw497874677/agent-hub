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

/**
 * 真 Hermes：一个 worker 一个网关（§17）。两个 hub 会话同时开：同一个网关进程；
 * 各自的中继令牌各走各的（分流器）；会话历史互不串（B 的模型请求里看不到 A 的话）；
 * 中断 A 不影响 B；两个都关了网关才退。
 */
test('真 Hermes：两个会话共用一个网关，互相隔开', { skip: process.env['HERMES_LIVE'] !== '1', timeout: 240_000 }, async () => {
  const calls: { auth: string; model: string; text: string }[] = [];
  const model = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
        return;
      }
      const parsed = JSON.parse(body || '{}') as { model?: string; stream?: boolean; messages?: unknown };
      const text = JSON.stringify(parsed.messages ?? []);
      calls.push({ auth: String(req.headers.authorization), model: String(parsed.model), text });
      const slow = text.includes('慢慢数');
      if (parsed.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: 'slow-1', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer);
        if (n++ >= (slow ? 300 : 3)) {
          clearInterval(timer);
          res.end(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'slow-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
          return;
        }
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'slow-1', choices: [{ index: 0, delta: { content: `字${n} ` }, finish_reason: null }] })}\n\n`);
      }, 150);
      res.on('close', () => clearInterval(timer));
    });
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
  const root = await mkdtemp(join(tmpdir(), 'hermes-live2-'));
  const logs: string[] = [];
  const runtime = createHermesRuntime({ root, log: (message) => logs.push(message), bootTimeoutMs: 90_000 });
  const open = async (id: string, token: string) => {
    const workspaceRoot = join(root, `ws-${id}`);
    await mkdir(workspaceRoot);
    const started = await runtime.start({
      sessionId: id as SessionId,
      taskId: 't' as TaskId,
      workspaceRoot,
      resume: null,
      options: {},
      provider: { baseUrl, token, models: [{ id: 'slow-1', name: 'slow-1' }] }
    } as unknown as StartSpec);
    assert.ok(started.ok, `起不来：${started.ok ? '' : started.error.message}\n${logs.join('\n')}`);
    const session = started.value;
    const it = session.events()[Symbol.asyncIterator]();
    const next = async (until: (event: SessionEvent) => boolean, ms: number) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const step = await Promise.race([it.next(), new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now()))]);
        if (!step || step.done) break;
        if (until(step.value)) return step.value;
      }
      throw new Error(`${id} 等不到事件`);
    };
    return { session, next };
  };
  const a = await open('two-a', 'tok-a');
  const b = await open('two-b', 'tok-b');
  try {
    assert.equal(a.session.pid(), b.session.pid(), '两个会话应该是同一个网关进程');
    const pid = a.session.pid();
    assert.ok((await a.session.prompt({ text: '慢慢数 SECRET-A', parts: [] })).ok);
    await a.next((event) => event.kind === 'text', 60_000);
    assert.ok((await b.session.prompt({ text: '说 hi BETA', parts: [] })).ok);
    const endedB = await b.next((event) => event.kind === 'ended', 60_000);
    assert.equal((endedB as { outcome: string }).outcome, 'done', 'B 应该正常跑完（A 还在跑）');
    await a.session.interrupt();
    const endedA = await a.next((event) => event.kind === 'ended', 30_000);
    assert.notEqual((endedA as { outcome: string }).outcome, 'done');
    const ofA = calls.filter((call) => call.text.includes('SECRET-A'));
    const ofB = calls.filter((call) => call.text.includes('BETA'));
    assert.ok(ofA.length > 0 && ofB.length > 0);
    assert.ok(ofA.every((call) => call.auth === 'Bearer tok-a' && call.model === 'slow-1'), 'A 的请求要用 A 的令牌、真模型名');
    assert.ok(ofB.every((call) => call.auth === 'Bearer tok-b' && !call.text.includes('SECRET-A')), 'B 的请求不能带 A 的令牌或 A 的话');
    assert.ok(ofB.some((call) => call.text.includes(join(root, 'ws-two-b'))), 'B 的 instructions 里应该有 B 自己的工作区');
    // A 关了，网关还在（B 在用）；B 也关了网关才退
    await a.session.dispose();
    assert.ok(pid && (() => { try { process.kill(pid, 0); return true; } catch { return false; } })(), 'A 关了网关不该退');
    assert.ok((await b.session.prompt({ text: '再说 hi BETA2', parts: [] })).ok);
    await b.next((event) => event.kind === 'ended', 60_000);
    await b.session.dispose();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(pid && (() => { try { process.kill(pid, 0); return false; } catch { return true; } })(), '都关了网关应该退');
    console.log(`两会话共用网关 pid=${pid}，模型请求 A ${ofA.length} 次 / B ${ofB.length} 次`);
  } finally {
    await a.session.dispose();
    await b.session.dispose();
    model.close();
  }
});
