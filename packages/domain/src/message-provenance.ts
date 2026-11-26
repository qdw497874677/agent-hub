/** Internal bus provenance. This is not an authorization grant. */
export interface PromptMessageOrigin {
  readonly kind: 'agent_message';
  readonly messageId: string;
  readonly messageKind: 'send' | 'ask' | 'reply';
  readonly initiator: 'account' | 'session_tool' | 'automatic_reply' | 'external_token' | 'system' | 'unknown';
  readonly sender: 'session' | 'external' | 'system';
  readonly sourceSessionId?: string;
}

/** Only this projection may enter the journal or be exposed to clients. */
export type PromptMessageSource = Pick<PromptMessageOrigin, 'kind' | 'messageId' | 'messageKind' | 'initiator' | 'sender'>;

export function promptMessageSource(origin: PromptMessageOrigin): PromptMessageSource {
  return { kind: origin.kind, messageId: origin.messageId, messageKind: origin.messageKind, initiator: origin.initiator, sender: origin.sender };
}
