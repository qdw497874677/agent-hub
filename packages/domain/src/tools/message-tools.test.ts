import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asSessionId } from '../ids.ts';
import type { ToolContext } from '../ports/tool-provider.ts';
import type { MessageBus } from '../use-cases/messaging.ts';
import { createMessageToolProvider } from './message-tools.ts';

test('message tools use the granted session and mark send/ask as tool initiated', async () => {
  const calls: unknown[][] = [];
  const bus = {
    accept: async (...args: unknown[]) => {
      calls.push(args);
      return { ok: true, value: { messageId: 'm', traceId: 't', status: 'queued', targetSessionId: 'target' } };
    },
    reply: async (...args: unknown[]) => {
      calls.push(args);
      return { ok: true, value: { messageId: 'r' } };
    }
  } as unknown as MessageBus;
  const ctx = { grant: { sessionId: asSessionId('granted') }, now: 1 } as ToolContext;
  const provider = createMessageToolProvider(bus);
  for (const name of ['agent.send', 'agent.ask']) {
    const result = await provider.call(name, { to: 'session:target', body: 'body', fromSessionId: 'forged', initiator: { kind: 'account', accountId: 'forged' } }, ctx);
    assert.ok(result.ok);
  }
  for (const [index, kind] of ['send', 'ask'].entries()) {
    assert.deepEqual(calls[index], [
      { fromSessionId: 'granted', kind, to: 'session:target', body: 'body', idempotencyKey: undefined },
      { initiator: { kind: 'session_tool' } }
    ]);
  }
  const reply = await provider.call('agent.reply', { body: 'answer', messageId: 'ask' }, ctx);
  assert.ok(reply.ok);
  assert.deepEqual(calls[2], ['granted', 'answer', 'ask', {}]);
});
