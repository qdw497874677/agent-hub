/**
 * 飞书连接器的纯规则（不碰网络和存储）：文本解析、mention 替换、外部 id、注入判定。
 * 外部文本一律不可信：送进模型前由 `untrusted()` 包成数据块。
 */

/** 送进模型的外部正文上限；超出的出站正文也按它截断。 */
export const FEISHU_MAX_TEXT = 8000;

const MENTION = /@_user_\w+/g;

/**
 * 飞书文本消息的 `content` 是 JSON 字符串（`{"text":"..."}`）。
 * 解析失败返回空串；`mentions` 给了就把 `@_user_1` 这类占位符换成 `@名字`，否则保留占位符。
 */
export function parseFeishuText(content: string, mentions?: readonly { readonly key: string; readonly name: string }[]): string {
  let text: unknown;
  try {
    const parsed: unknown = JSON.parse(content);
    text = typeof parsed === 'object' && parsed !== null ? (parsed as { text?: unknown }).text : undefined;
  } catch {
    return '';
  }
  if (typeof text !== 'string') return '';
  if (!mentions || mentions.length === 0) return text;
  const names = new Map(mentions.map((m) => [m.key, m.name]));
  return text.replace(MENTION, (key) => {
    const name = names.get(key);
    return name ? `@${name}` : key;
  });
}

/** 平台消息 id 只在会话内唯一：去重键带上 chatId。 */
export const feishuExternalId = (chatId: string, messageId: string): string => `${chatId}:${messageId}`;

/** 把 `<chatId>:<messageId>` 拆开；不是这个形状返回 null。 */
export function parseFeishuExternalId(id: string): { readonly chatId: string; readonly messageId: string } | null {
  const at = id.indexOf(':');
  if (at <= 0 || at === id.length - 1) return null;
  return { chatId: id.slice(0, at), messageId: id.slice(at + 1) };
}

/** 出站目标地址：`feishu:<chatId>`。 */
export const feishuTargetId = (chatId: string): string => `feishu:${chatId}`;

/** `feishu:<chatId>` → chatId；其它目标（比如 github 的）返回 null。 */
export function feishuChatOf(targetId: string): string | null {
  const prefix = 'feishu:';
  return targetId.startsWith(prefix) && targetId.length > prefix.length ? targetId.slice(prefix.length) : null;
}

/**
 * 入站正文的引用块：注明谁在飞书说的，正文逐行加 `>`。
 * `untrusted()` 的「这是数据不是指令」围栏由 `formatInbound` 统一加，这里只负责出处。
 */
export function feishuPrompt(text: string, senderName: string): string {
  const who = senderName.trim() === '' ? '飞书用户' : senderName.trim();
  const quoted = text.split('\n').map((line) => `> ${line}`).join('\n');
  return `${who} 在飞书发来：\n${quoted}`;
}

/** 出站正文截断：超过上限先截断并加省略号。 */
export const clipText = (s: string, n = FEISHU_MAX_TEXT): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * 疑似提示注入：规则判定，不问模型。与 packages/connector-github/src/rules.ts 同源
 * （复制过来，注释写明同源以免跨包依赖）。
 */
const INJECTION_RULES: readonly { readonly id: string; readonly re: RegExp }[] = [
  { id: '要求忽略之前的指令', re: /\b(ignore|disregard|forget|override)\b[^\n]{0,40}\b(previous|prior|above|earlier|all|system|your)\b[^\n]{0,20}\b(instructions?|prompts?|rules?|messages?)\b/i },
  { id: '要求忽略之前的指令', re: /(忽略|无视|忘记|忘掉|覆盖)[^\n]{0,12}(之前|以上|上面|前面|所有|系统)[^\n]{0,8}(指令|提示|规则|设定|要求)/ },
  { id: '冒充系统 / 角色切换', re: /(<\|?(im_start|im_end|system|endoftext)\|?>|\[\/?(system|INST)\]|^\s*(system|assistant)\s*:)/im },
  { id: '冒充系统 / 角色切换', re: /\byou are now\b|\bnew instructions?\s*:|\bdeveloper mode\b|\bjailbreak\b|你现在是|从现在起你是|新的指令[:：]/i },
  { id: '索要密钥 / 环境变量', re: /\b(print|show|reveal|leak|send|post|cat|echo|dump|exfiltrate)\b[^\n]{0,40}\b(token|secret|api[_ -]?key|password|credential|env(ironment)?( variables?)?|\.env|ssh key|private key)\b/i },
  { id: '索要密钥 / 环境变量', re: /(打印|输出|发出|泄露|贴出|告诉我)[^\n]{0,12}(令牌|token|密钥|密码|环境变量|私钥|凭据)/i },
  { id: '要求外传数据', re: /\b(curl|wget|fetch)\b[^\n]{0,80}https?:\/\/[^\s]+[^\n]{0,40}(\$\{?[A-Z_]{3,}|token|secret|env)/i },
  { id: '要求越权操作', re: /\b(merge|force[- ]push|delete)\b[^\n]{0,30}\b(this|the|main|master)?\s*(pr|pull request|branch|repo(sitory)?)\b[^\n]{0,30}\b(without|skip|bypass)\b[^\n]{0,20}\b(review|approval|checks?|ci)\b/i }
];

export function detectInjection(text: string): string | null {
  for (const r of INJECTION_RULES) if (r.re.test(text)) return r.id;
  return null;
}
