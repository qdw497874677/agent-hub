import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionInbox, type InboxSource } from './session-inbox.ts';

const source = (id: string, open: boolean, log: string[]): InboxSource => ({
  id,
  open: async () => open,
  end: async (_sid, outcome, reason) => {
    log.push(`${id}:${outcome}:${reason ?? ''}`);
  }
});

test('占用：任一来源还在等回话就算被占；按注册顺序问，读失败不影响后面的来源', async () => {
  const log: string[] = [];
  const broken: InboxSource = { id: 'broken', open: async () => { throw new Error('db gone'); }, end: async () => undefined };
  const inbox = createSessionInbox({
    sources: [broken, source('p2p', false, log), source('group', true, log)],
    onError: (id, error) => log.push(`err:${id}:${String(error)}`)
  });
  assert.deepEqual(inbox.sources, ['broken', 'p2p', 'group']);
  assert.equal(await inbox.occupied('s1'), true);
  assert.match(log[0] ?? '', /err:broken/);
});

test('回合结束：按注册顺序收尾；一个来源抛错不挡住其它来源', async () => {
  const log: string[] = [];
  const failing: InboxSource = {
    id: 'connector',
    open: async () => false,
    end: async () => { throw new Error('boom'); }
  };
  const inbox = createSessionInbox({
    sources: [source('p2p', false, log), failing, source('delivery', false, log)],
    onError: (id, error) => log.push(`err:${id}:${String(error)}`)
  });
  await inbox.end('s1', 'failed', 'Free usage limit reached');
  assert.deepEqual(log, ['p2p:failed:Free usage limit reached', 'err:connector:Error: boom', 'delivery:failed:Free usage limit reached']);
});

test('空闲：所有来源都说没在等，才返回 false', async () => {
  const log: string[] = [];
  const inbox = createSessionInbox({ sources: [source('p2p', false, log), source('group', false, log)] });
  assert.equal(await inbox.occupied('s1'), false);
});
