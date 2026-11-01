import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SessionEvent, SessionId, StartSpec, TaskId } from '@agent-hub/domain';
import { createHermesRuntime } from './hermes-runtime.ts';

/**
 * 真 Hermes 批准卡（ADR 0023）：假模型让 Hermes 跑一条危险命令（rm -rf），Hermes 停下要批准，
 * 适配器推 approval(request)；第一轮拒绝 → 文件还在；第二轮允许 → 文件没了。HERMES_LIVE=1 才跑。
 */
test('真 Hermes：批准卡 拒绝 / 允许', { skip: process.env['HERMES_LIVE'] !== '1', timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hermes-approval-'));
  const workspaceRoot = join(root, 'ws');
  const victim = join(workspaceRoot, 'victim');
  await mkdir(victim, { recursive: true });
  const model = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'fake-1', object: 'model' }] }));
        return;
      }
      const parsed = JSON.parse(body || '{}') as { messages?: { role: string }[]; stream?: boolean };
      const afterTool = (parsed.messages ?? []).at(-1)?.role === 'tool';
      const message = afterTool
        ? { role: 'assistant', content: 'done' }
        : { role: 'assistant', content: null, tool_calls: [{ id: `call_${Date.now()}`, type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: `rm -rf ${victim}` }) } }] };
      if (parsed.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: 'fake-1', choices: [{ index: 0, message, finish_reason: afterTool ? 'stop' : 'tool_calls' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = afterTool ? { role: 'assistant', content: 'done' } : { role: 'assistant', tool_calls: message.tool_calls!.map((c, index) => ({ index, ...c })) };
      res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta: {}, finish_reason: afterTool ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
  const logs: string[] = [];
  const runtime = createHermesRuntime({ root, log: (m) => logs.push(m), bootTimeoutMs: 90_000 });
  const started = await runtime.start({ sessionId: 'appr-1' as SessionId, taskId: 't' as TaskId, workspaceRoot, resume: null, options: {}, provider: { baseUrl, token: 'local-fake', models: [{ id: 'fake-1', name: 'fake-1' }] } } as unknown as StartSpec);
  assert.ok(started.ok, `起不来：${started.ok ? '' : started.error.message}\n${logs.join('\n')}`);
  const session = started.value;
  const it = session.events()[Symbol.asyncIterator]();
  const next = async (until: (e: SessionEvent) => boolean, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const step = await Promise.race([it.next(), new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now()))]);
      if (!step || step.done) break;
      if (process.env['HERMES_LIVE_DEBUG']) console.log('event', JSON.stringify(step.value).slice(0, 200));
      if (until(step.value)) return step.value;
    }
    throw new Error(`等不到事件\n${logs.join('\n')}`);
  };
  try {
    for (const decision of ['deny', 'allow'] as const) {
      assert.ok((await session.prompt({ text: '清理 victim', parts: [] } as never)).ok);
      const request = await next((e) => e.kind === 'approval' && e.phase === 'request', 90_000);
      assert.ok(request.kind === 'approval' && request.title?.includes('rm -rf'), JSON.stringify(request));
      assert.ok((await session.respondApproval!(request.id, decision, { id: 'u', name: 'tester' })).ok);
      const resolved = await next((e) => e.kind === 'approval' && e.phase === 'resolved', 5_000);
      assert.ok(resolved.kind === 'approval' && resolved.decision === decision && resolved.by === 'user');
      assert.equal((await session.respondApproval!(request.id, 'allow')).ok, false, '重复回答要被拒');
      await next((e) => e.kind === 'ended', 90_000);
      assert.equal(existsSync(victim), decision === 'deny', `${decision} 之后 victim ${existsSync(victim) ? '还在' : '没了'}`);
    }
  } finally {
    await session.dispose();
    model.close();
  }
});
