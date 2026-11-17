import type { ConnectorBinding, InboundContext, InboundSource } from '@agent-hub/domain';
import { untrusted } from '@agent-hub/domain';
import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';
import { detectInjection, feishuExternalId, feishuPrompt, parseFeishuText } from './rules.ts';

/** 长连接收到的一条文本消息（已归一化，测试可直接构造）。 */
export interface FeishuInboundMessage {
  readonly chatId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly text: string;
  readonly mentionsBot: boolean;
}

export interface FeishuSourceDeps {
  readonly appId: string;
  readonly appSecret: string;
  readonly log?: (line: string) => void;
  /** 测试注入：假的长连接（默认用 SDK 的 WSClient + EventDispatcher）。 */
  readonly connect?: (handler: (message: FeishuInboundMessage) => void) => Promise<{ close(): void }>;
}

/** SDK 事件里我们真正读的字段（`im.message.receive_v1` 的 event 部分）。 */
interface FeishuMessageEvent {
  readonly sender?: {
    readonly sender_type?: string;
    readonly sender_id?: { readonly union_id?: string; readonly user_id?: string; readonly open_id?: string };
  };
  readonly message?: {
    readonly message_id?: string;
    readonly chat_id?: string;
    readonly message_type?: string;
    readonly content?: string;
    readonly mentions?: readonly { readonly key?: string; readonly name?: string; readonly mentioned_type?: string }[];
  };
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** SDK 事件 → 归一化消息；不是用户发的文本就返回 null。 */
export function toInboundMessage(data: FeishuMessageEvent): FeishuInboundMessage | null {
  // 机器人自己发的（回声第一层）：sender_type === 'app' 直接丢。
  if (data.sender?.sender_type === 'app') return null;
  const message = data.message;
  if (!message || message.message_type !== 'text') return null;
  if (!message.chat_id || !message.message_id) return null;
  const senderId = data.sender?.sender_id?.open_id ?? data.sender?.sender_id?.user_id ?? data.sender?.sender_id?.union_id ?? 'unknown';
  const mentions = (message.mentions ?? []).flatMap((m) => (m.key && m.name ? [{ key: m.key, name: m.name }] : []));
  const text = parseFeishuText(message.content ?? '', mentions).trim();
  if (text === '') return null;
  return {
    chatId: message.chat_id,
    messageId: message.message_id,
    senderId,
    // 事件里没有发送者名字（要额外调通讯录接口），先用 id 当名字；只影响引用块里的出处。
    senderName: senderId,
    text,
    // 飞书只在私聊和「@ 了机器人」的群消息上推 `im.message.receive_v1`；
    // 事件里的 mentions 拿不到可靠的「是不是本机器人」判定，所以收到文本就按对机器人说的处理。
    mentionsBot: true
  };
}

/** 默认长连接：WSClient 自带断线重连；close 只关连接。 */
async function connectWithSdk(deps: FeishuSourceDeps, handler: (message: FeishuInboundMessage) => void): Promise<{ close(): void }> {
  const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.warn });
  dispatcher.register({
    'im.message.receive_v1': (data) => {
      const inbound = toInboundMessage(data as FeishuMessageEvent);
      if (inbound) handler(inbound);
      return undefined;
    }
  });
  const ws = new WSClient({
    appId: deps.appId,
    appSecret: deps.appSecret,
    loggerLevel: LoggerLevel.warn,
    autoReconnect: true,
    onError: (error) => deps.log?.(`[feishu] 长连接失败：${error.message}`),
    onReconnecting: () => deps.log?.('[feishu] 长连接断开，正在重连')
  });
  await ws.start({ eventDispatcher: dispatcher });
  return { close: () => ws.close({ force: true }) };
}

/** 一条消息 → 每个匹配的 binding 各 emit 一次。 */
export async function handleFeishuMessage(ctx: InboundContext, message: FeishuInboundMessage, log?: (line: string) => void): Promise<void> {
  const bindings: readonly ConnectorBinding[] = await ctx.bindings();
  const externalId = feishuExternalId(message.chatId, message.messageId);
  const hit = detectInjection(message.text);
  for (const binding of bindings) {
    if (binding.connector !== 'feishu') continue;
    const only = binding.params.chatId;
    if (typeof only === 'string' && only.trim() !== '' && only !== message.chatId) continue;
    if (hit) {
      await ctx.skip(binding.id, { externalId }, `疑似注入（${hit}），已隔离，没交给 bot`);
      continue;
    }
    const title = message.text.split('\n')[0]?.slice(0, 80) || '飞书消息';
    await ctx.emit(binding.id, {
      kind: 'message',
      externalId,
      title,
      text: untrusted(feishuPrompt(message.text, message.senderName)),
      note: '（来自飞书）',
      // 群目标落帖时作者写发送者，而不是「feishu」；事件里没有真名时 senderName 是 open_id。
      author: { name: message.senderName, externalId: message.senderId }
    });
    log?.(`[feishu] 入站 ${externalId} → binding ${binding.id}`);
  }
}

export function createFeishuSource(deps: FeishuSourceDeps): InboundSource {
  return {
    id: 'feishu',
    label: '飞书',
    kinds: ['message'],
    delivery: 'push',
    validate(kind, params) {
      if (kind !== 'message') return '飞书只有 message';
      if (params.chatId !== undefined && (typeof params.chatId !== 'string' || params.chatId.trim() === '')) return 'chatId 要是非空字符串';
      return null;
    },
    describe(binding) {
      const chatId = binding.params.chatId;
      return typeof chatId === 'string' && chatId.trim() !== '' ? `飞书会话 ${chatId}` : '飞书任意会话';
    },
    start(ctx) {
      let handle: { close(): void } | null = null;
      let stopped = false;
      const connect = deps.connect ?? ((handler: (message: FeishuInboundMessage) => void) => connectWithSdk(deps, handler));
      void connect((message) => {
        if (stopped) return;
        void handleFeishuMessage(ctx, message, deps.log).catch((error: unknown) => deps.log?.(`[feishu] 处理消息失败：${errorText(error)}`));
      })
        .then((connected) => {
          if (stopped) connected.close();
          else handle = connected;
        })
        .catch((error: unknown) => deps.log?.(`[feishu] 长连接启动失败：${errorText(error)}`));
      return {
        stop() {
          stopped = true;
          try {
            handle?.close();
          } catch (error) {
            deps.log?.(`[feishu] 关闭长连接失败：${errorText(error)}`);
          }
          handle = null;
        }
      };
    }
  };
}
