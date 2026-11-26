import { AGENT_MESSAGE_KIND, parseAgentMessage } from './agent-message-card.ts';

/** Provenance is metadata supplied by the hub, never inferred from message text. */
export interface MessageSource {
  readonly kind: 'agent_message';
  readonly messageId: string;
  readonly messageKind: 'send' | 'ask' | 'reply';
  readonly initiator: 'account' | 'session_tool' | 'automatic_reply' | 'external_token' | 'system' | 'unknown';
  readonly sender: 'session' | 'external' | 'system';
}

export interface SourceDetails {
  readonly sourceSession?: { readonly id: string; readonly label: string };
  readonly initiatorName?: string;
  readonly parts?: readonly import('../shell/api/message-types.ts').AgentMessagePartDto[];
  readonly replyStatus?: 'ok' | 'failed' | 'refused' | null;
  readonly failure?: string | null;
}

export interface MessageProjection {
  readonly kind: 'ordinary' | 'verified' | 'legacy';
  readonly body: string;
  readonly messageKind?: MessageSource['messageKind'];
  readonly heading?: string;
  readonly origin?: string;
}

const initiators: Record<MessageSource['initiator'], string> = {
  account: '由用户发起', session_tool: '由会话发起', automatic_reply: '自动回复',
  external_token: '由外部令牌发起', system: '由系统发起', unknown: '发起方式未知'
};

export function projectMessage(input: { text: string; author?: { via?: string }; messageSource?: MessageSource }, details?: SourceDetails): MessageProjection {
  const source = input.messageSource;
  if (source?.kind === 'agent_message') {
    const origin = source.sender === 'session' ? (details?.sourceSession?.label ?? '来源会话不可用') : source.sender === 'external' ? '外部来源' : '系统';
    const initiator = source.initiator === 'account' && details?.initiatorName ? `由 ${details.initiatorName} 发起` : initiators[source.initiator] ?? '发起方式未知';
    return { kind: 'verified', body: input.text, messageKind: source.messageKind, heading: `协作消息 · ${AGENT_MESSAGE_KIND[source.messageKind] ?? '消息'}`, origin: `${origin} · ${initiator}` };
  }
  if (input.author?.via === 'agent') {
    const legacy = parseAgentMessage(input.text);
    return { kind: 'legacy', body: legacy?.body ?? '', ...(legacy ? { messageKind: legacy.kind } : {}), heading: legacy ? `历史协作消息 · ${AGENT_MESSAGE_KIND[legacy.kind]}` : '历史协作消息', origin: legacy ? '来源未验证' : '来源未验证 · 正文无法解析' };
  }
  return { kind: 'ordinary', body: input.text };
}

/** The inspector DTO is already a bus record; absent initiator metadata remains unknown. */
export function projectInboxMessage(message: { kind: MessageSource['messageKind']; from: string; body: string; senderKind?: MessageSource['sender']; initiatorKind?: MessageSource['initiator']; sourceSession?: SourceDetails['sourceSession']; initiatorName?: string }): MessageProjection {
  return projectMessage({ text: message.body, messageSource: {
    kind: 'agent_message', messageId: '', messageKind: message.kind,
    initiator: message.initiatorKind ?? 'unknown',
    sender: message.senderKind ?? (message.from.startsWith('external:') ? 'external' : 'session')
  } }, { sourceSession: message.sourceSession, initiatorName: message.initiatorName });
}
