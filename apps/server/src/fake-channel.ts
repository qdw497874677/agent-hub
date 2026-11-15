import type { ConnectorBinding, InboundEvent, InboundSource } from '@agent-hub/domain';
import type { OutboxDeliver } from '@agent-hub/domain';

/**
 * 假渠道（#221 步骤 8）：不连任何外部平台，用来把「入站 → 目标 → 出站 → 回声去重」整条链跑通。
 *
 * 只在 `HUB_FAKE_CHANNEL=1` 时注册。它自己不含业务判断：
 * - 入站：`inbound()` 造一条规范事件，交给 connector hub 按 binding 投递；
 * - 出站：`createFakeOutbound()` 当 pump 的投递端，把发出去的消息记在内存里供断言；
 * - 回声：用 `looksLikeEcho()`（domain）对刚发出去的行做比对，入站侧据此丢弃。
 */
export interface FakeChannel {
  readonly source: InboundSource;
  inbound(text: string, externalId: string): InboundEvent;
}

export function createFakeChannel(): FakeChannel {
  const source: InboundSource = {
    id: 'fake',
    label: '假渠道',
    kinds: ['message'],
    // 外部主动推来、不会重发：忙时排队，不能丢。
    delivery: 'push',
    validate: () => null,
    describe: (binding: ConnectorBinding) => `假渠道 · ${String(binding.params['name'] ?? binding.name)}`,
    start: () => ({ stop: () => undefined })
  };
  return {
    source,
    inbound: (text, externalId) => ({ kind: 'message', externalId, title: text.slice(0, 80), text })
  };
}

export interface FakeSent {
  readonly targetId: string;
  readonly body: string;
  readonly externalMessageId: string;
}

/** 假渠道的出站投递端：记进内存并给一个稳定的外部 id，供回声第 2 层比对。 */
export function createFakeOutbound(log: FakeSent[] = []): { sent(): readonly FakeSent[]; deliver: OutboxDeliver } {
  let seq = 0;
  return {
    sent: () => [...log],
    deliver: async (message) => {
      seq += 1;
      const externalMessageId = `fake_${seq}`;
      log.push({ targetId: message.target.id, body: message.body, externalMessageId });
      return { ok: true, externalMessageId };
    }
  };
}

export interface FakeReplyRoute {
  readonly bindingId: string;
  readonly conversation: string;
  readonly replyToExternalId: string | null;
}

/**
 * 假渠道的回程（步骤 8）：会话回合结束后，把这一轮的最后一段文字投进出站队列，
 * 由 `createFakeOutbound` 收下来 —— 这样「入站 → 会话 → 出站」整条链在没有真实 IM 时也能跑。
 */
export function createFakeReplies(deps: {
  enqueue(input: { target: { kind: 'external'; id: string }; body: string; author: { kind: 'agent'; name: string }; origin: 'reply'; replyToExternalId: string | null; externalConversationId: string | null }): Promise<unknown>;
  tail(sessionId: string, limit: number): Promise<readonly { event: { kind: string; delta?: string } }[]>;
}) {
  const routes = new Map<string, FakeReplyRoute>();
  const lastTurnText = async (sessionId: string): Promise<string> => {
    const entries = await deps.tail(sessionId, 500);
    let lastPrompt = -1;
    entries.forEach((entry, index) => { if (entry.event.kind === 'prompt') lastPrompt = index; });
    return entries.slice(lastPrompt + 1).map((entry) => (entry.event.kind === 'text' ? entry.event.delta ?? '' : '')).join('').trim();
  };
  return {
    remember(sessionId: string, bindingId: string) {
      routes.set(sessionId, { bindingId, conversation: bindingId, replyToExternalId: null });
    },
    forget(sessionId: string) { routes.delete(sessionId); },
    async finish(sessionId: string): Promise<string | null> {
      const route = routes.get(sessionId);
      if (!route) return null;
      const body = await lastTurnText(sessionId);
      if (body === '') return null;
      await deps.enqueue({
        target: { kind: 'external', id: `fake:${route.conversation}` },
        body, author: { kind: 'agent', name: 'fake' }, origin: 'reply',
        replyToExternalId: route.replyToExternalId, externalConversationId: route.conversation
      });
      return body;
    }
  };
}
