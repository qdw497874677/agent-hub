import { invalid, type DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { ToolContext, ToolDescriptor, ToolProvider } from '../ports/tool-provider.ts';
import type { MessageBus } from '../use-cases/messaging.ts';
import type { AgentMessage } from '../messaging.ts';
import type { GroupChat } from '../use-cases/groups.ts';
import { HOST_MAX_ASSIGNEES } from '../groups.ts';

/** agent 间通信工具（ADR 0018 · P2P）。发送方永远是授权绑定的那条会话，参数里没有「我是谁」。 */
export const MESSAGE_TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'agent.directory',
    version: 1,
    scope: 'agent:message',
    description: 'List agents you can message in this project: other sessions (session:<id>, with idle/busy status) and project roles (role:<name>). Spawning a new session for a role needs a human to approve it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'agent.peers',
    version: 1,
    scope: 'agent:message',
    description:
      'List the sessions you can talk to (explicit links plus your spawn parent): handle (use to:"peer:<handle>"), session id, machine (workerId), repo, branch, title and status (idle / busy / archived). Only these sessions can exchange messages with you.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'agent.send',
    version: 1,
    scope: 'agent:message',
    perMinute: 20,
    description:
      'Send a one-way message to another agent (to: "peer:<handle>", "session:<id>" or "bot:<name>"). Delivered right away if the target is idle, otherwise queued. No reply is expected. wake:false only drops it in their inbox (they see an unread count next turn) instead of starting a turn — use it for FYI notes. Archived targets refuse messages (failure "archived"); repeated identical messages or more than 6 per minute to one peer are refused — batch them.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', minLength: 3 },
        body: { type: 'string', minLength: 1, maxLength: 32768 },
        parts: {
          type: 'array',
          maxItems: 8,
          description:
            'Optional structured attachments (max 8, ≤16KB total): {type:"data",schema?,data} for results (e.g. schema "verify-result/v1"); {type:"ref",repo,branch?,sha?} for git refs (repo must be a project repo name); {type:"file",session,path,member?} to point at a file the receiver can open with workspace.read; {type:"link",url,label?} (http/https only).',
          items: { type: 'object' }
        },
        wake: { type: 'boolean', default: true },
        idempotencyKey: { type: 'string', maxLength: 100 }
      },
      required: ['to', 'body'],
      additionalProperties: false
    }
  },
  {
    name: 'agent.ask',
    version: 1,
    scope: 'agent:message',
    perMinute: 20,
    description:
      'Ask another agent something (to: "peer:<handle>", "session:<id>" or "bot:<name>"). Returns immediately with a messageId; the answer (with status ok / failed / refused and optional parts) arrives later as a new message in your conversation wrapped in <agent-message kind="reply">. Do not poll: if you have nothing else to do, end your turn. timeoutSec (30–14400, default 1800) bounds how long to wait before a "timeout" failure reply.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', minLength: 3 },
        body: { type: 'string', minLength: 1, maxLength: 32768 },
        parts: {
          type: 'array',
          maxItems: 8,
          description:
            'Optional structured attachments (max 8, ≤16KB total): {type:"data",schema?,data} for results (e.g. schema "verify-result/v1"); {type:"ref",repo,branch?,sha?} for git refs (repo must be a project repo name); {type:"file",session,path,member?} to point at a file the receiver can open with workspace.read; {type:"link",url,label?} (http/https only).',
          items: { type: 'object' }
        },
        timeoutSec: { type: 'integer', minimum: 30, maximum: 14400 },
        idempotencyKey: { type: 'string', maxLength: 100 }
      },
      required: ['to', 'body'],
      additionalProperties: false
    }
  },
  {
    name: 'agent.reply',
    version: 1,
    scope: 'agent:message',
    perMinute: 20,
    description:
      'Answer an <agent-message kind="ask"> delivered to you. messageId may be omitted when exactly one question is waiting. status: ok (default) / failed (you tried, it did not work) / refused (you will not do it). Put machine-readable results in parts, e.g. {type:"data",schema:"verify-result/v1",data:{...}}. If you never call this, your final text of the turn is sent as the reply.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', minLength: 1, maxLength: 32768 },
        messageId: { type: 'string' },
        status: { type: 'string', enum: ['ok', 'failed', 'refused'] },
        parts: {
          type: 'array',
          maxItems: 8,
          description:
            'Optional structured attachments (max 8, ≤16KB total): {type:"data",schema?,data} for results (e.g. schema "verify-result/v1"); {type:"ref",repo,branch?,sha?} for git refs (repo must be a project repo name); {type:"file",session,path,member?} to point at a file the receiver can open with workspace.read; {type:"link",url,label?} (http/https only).',
          items: { type: 'object' }
        },
      },
      required: ['body'],
      additionalProperties: false
    }
  },
  {
    name: 'agent.status',
    version: 1,
    scope: 'agent:message',
    description: 'Check a message you sent or received: queued / awaiting_approval / delivered / answered / done / failed / denied, with the reply text if answered.',
    inputSchema: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'], additionalProperties: false }
  },
  {
    name: 'agent.inbox',
    version: 1,
    scope: 'agent:message',
    description: 'List recent agent messages to and from this session, newest first. unreadOnly:true lists only unread notes sent to you with wake:false (and marks them read).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }, unreadOnly: { type: 'boolean', default: false } },
      additionalProperties: false
    }
  },
  {
    name: 'group.dispatch',
    version: 1,
    scope: 'agent:message',
    perMinute: 20,
    description: `Only for a group-chat host: decide who answers the group message you were just given. Pass up to ${HOST_MAX_ASSIGNEES} member role names in assignees (never yourself), or decline: true with an optional short reply.`,
    inputSchema: {
      type: 'object',
      properties: {
        assignees: { type: 'array', items: { type: 'string' }, maxItems: HOST_MAX_ASSIGNEES },
        note: { type: 'string', maxLength: 500 },
        decline: { type: 'boolean' },
        reply: { type: 'string', maxLength: 4000 }
      },
      additionalProperties: false
    }
  }
];

const record = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export const messageView = (m: AgentMessage) => ({
  messageId: m.id,
  traceId: m.traceId,
  kind: m.kind,
  from: `session:${m.fromSessionId}`,
  to: m.to,
  targetSessionId: m.targetSessionId,
  status: m.status,
  depth: m.depth,
  replyTo: m.replyTo,
  body: m.body,
  reply: m.replyBody,
  replySource: m.replySource,
  failure: m.failure,
  failureDetail: m.failureDetail,
  parts: m.parts ?? [],
  wake: m.wake !== false,
  replyStatus: m.replyStatus ?? null,
  replyParts: m.replyParts ?? [],
  readAt: m.readAt ?? null,
  holdReason: m.holdReason ?? null,
  deadlineAt: m.deadlineAt,
  createdAt: m.createdAt
});

const NEXT_AFTER_ASK = 'The answer will arrive as a new message in this conversation. Do not poll agent.status; if nothing else is left, end your turn.';

export function createMessageToolProvider(bus: MessageBus, groups?: GroupChat): ToolProvider {
  return {
    id: 'agent-messaging',
    tools: () => MESSAGE_TOOLS,
    async call(name: string, input: unknown, ctx: ToolContext): Promise<Result<unknown, DomainError>> {
      const args = record(input);
      const me = ctx.grant.sessionId;
      switch (name) {
        case 'agent.directory':
          return bus.directory(me);
        case 'agent.peers':
          return bus.peers(me);
        case 'agent.send':
        case 'agent.ask': {
          const to = str(args.to);
          const body = str(args.body);
          if (!to || !body) return err(invalid('要给 to 和 body'));
          const kind = name === 'agent.ask' ? 'ask' : 'send';
          const accepted = await bus.accept({
            fromSessionId: me,
            kind,
            to,
            body,
            idempotencyKey: str(args.idempotencyKey),
            ...(args.parts !== undefined ? { parts: args.parts } : {}),
            ...(typeof args.wake === 'boolean' ? { wake: args.wake } : {}),
            ...(typeof args.timeoutSec === 'number' ? { timeoutSec: args.timeoutSec } : {})
          });
          if (!accepted.ok) return accepted;
          const held = accepted.value.status === 'held' ? { next: 'Held for a human to release (you and this peer went back and forth too many times in one chain). Stop messaging this peer and end your turn.' } : {};
          return ok({ ...accepted.value, ...(kind === 'ask' && accepted.value.status !== 'held' ? { next: NEXT_AFTER_ASK } : {}), ...held });
        }
        case 'agent.reply': {
          const body = str(args.body);
          if (!body) return err(invalid('要给 body'));
          const status = str(args.status);
          return bus.reply(me, body, str(args.messageId), {
            ...(status ? { status: status as 'ok' | 'failed' | 'refused' } : {}),
            ...(args.parts !== undefined ? { parts: args.parts } : {})
          });
        }
        case 'agent.status': {
          const id = str(args.messageId);
          if (!id) return err(invalid('要给 messageId'));
          const found = await bus.status(me, id);
          return found.ok ? ok(messageView(found.value)) : found;
        }
        case 'agent.inbox': {
          const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 50) : 20;
          return ok((await bus.inbox(me, limit, { unreadOnly: args.unreadOnly === true, markRead: true })).map(messageView));
        }
        case 'group.dispatch':
          if (!groups) return err(invalid('群聊没有启用'));
          return groups.dispatch(me, args);
        default:
          return err(invalid(`没有这个工具：${name}`));
      }
    }
  };
}
