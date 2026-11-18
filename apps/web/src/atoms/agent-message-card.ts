/**
 * 时间线里的 agent 消息卡（会话通信 P1e）：hub 投进对话的一轮是「提示一行 + <agent-message …>正文</agent-message>」，
 * 这里把它拆回结构（谁发的、什么类型、回复状态、正文），对话页按卡片画，而不是一大段带标签的文字。
 * 解析失败就返回 null，原样显示文本（不猜）。
 */
export interface ParsedAgentMessage {
  readonly id: string;
  readonly kind: 'send' | 'ask' | 'reply';
  readonly from: string;
  readonly fromSession: string;
  readonly onBehalfOf: string;
  readonly replyTo: string | null;
  readonly status: string | null;
  readonly failure: string | null;
  readonly body: string;
}

const unescape = (text: string): string =>
  text.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

export function parseAgentMessage(text: string): ParsedAgentMessage | null {
  const match = /<agent-message ([^>]*)>\n([\s\S]*)\n<\/agent-message>\s*$/.exec(text);
  if (!match) return null;
  const attrs = new Map<string, string>();
  for (const attr of (match[1] ?? '').matchAll(/([a-z][a-z-]*)="([^"]*)"/g)) attrs.set(attr[1]!, unescape(attr[2] ?? ''));
  const kind = attrs.get('kind');
  if (kind !== 'send' && kind !== 'ask' && kind !== 'reply') return null;
  return {
    id: attrs.get('id') ?? '',
    kind,
    from: attrs.get('from') ?? '',
    fromSession: attrs.get('from-session') ?? '',
    onBehalfOf: attrs.get('on-behalf-of') ?? '',
    replyTo: attrs.get('reply-to') ?? null,
    status: attrs.get('status') ?? null,
    failure: attrs.get('failure') ?? null,
    body: unescape(match[2] ?? '')
  };
}

export const AGENT_MESSAGE_KIND: Record<ParsedAgentMessage['kind'], string> = { send: '通知', ask: '提问', reply: '回复' };
export const REPLY_STATUS_TEXT: Record<string, string> = { ok: '完成', failed: '失败', refused: '拒绝' };
