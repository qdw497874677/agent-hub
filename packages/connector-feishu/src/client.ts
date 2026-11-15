import { Client, LoggerLevel } from '@larksuiteoapi/node-sdk';

/** 飞书发送侧的最小接口：测试注入假实现，不连真飞书。 */
export interface FeishuClient {
  sendText(target: { readonly chatId: string }, text: string): Promise<{ readonly messageId: string }>;
  replyText(parentMessageId: string, text: string): Promise<{ readonly messageId: string }>;
}

/** 飞书 API 失败：业务 `code`（code !== 0）或 HTTP `status`；都没有代表网络错误。 */
export class FeishuError extends Error {
  readonly code: number | null;
  readonly status: number | null;

  constructor(message: string, code: number | null = null, status: number | null = null) {
    super(message);
    this.name = 'FeishuError';
    this.code = code;
    this.status = status;
  }
}

interface MessageResponse {
  readonly code?: number;
  readonly msg?: string;
  readonly data?: { readonly message_id?: string };
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function messageIdOf(res: MessageResponse, action: string): { readonly messageId: string } {
  if (res.code !== undefined && res.code !== 0) throw new FeishuError(`飞书 ${action} 失败（code ${res.code}）：${res.msg ?? '未知错误'}`, res.code);
  const messageId = res.data?.message_id;
  if (!messageId) throw new FeishuError(`飞书 ${action} 失败：没有返回 message_id`);
  return { messageId };
}

/** 用飞书官方 SDK 的 `im.message.create` / `im.message.reply`。 */
export function createFeishuClient(deps: {
  readonly appId: string;
  readonly appSecret: string;
  readonly log?: (line: string) => void;
}): FeishuClient {
  const client = new Client({ appId: deps.appId, appSecret: deps.appSecret, loggerLevel: LoggerLevel.warn });

  const call = async (action: string, request: () => Promise<MessageResponse>): Promise<{ readonly messageId: string }> => {
    try {
      return messageIdOf(await request(), action);
    } catch (error) {
      if (error instanceof FeishuError) throw error;
      const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
      const httpStatus = typeof status === 'number' && Number.isFinite(status) ? status : null;
      deps.log?.(`[feishu] ${action} 失败：${errorText(error)}`);
      throw new FeishuError(`飞书 ${action} 失败：${errorText(error)}`, null, httpStatus);
    }
  };

  return {
    sendText: (target, text) => call('发消息', () => client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: target.chatId, msg_type: 'text', content: JSON.stringify({ text }) }
    }) as Promise<MessageResponse>),
    replyText: (parentMessageId, text) => call('回消息', () => client.im.message.reply({
      path: { message_id: parentMessageId },
      data: { msg_type: 'text', content: JSON.stringify({ text }) }
    }) as Promise<MessageResponse>)
  };
}
