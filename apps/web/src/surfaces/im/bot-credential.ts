/**
 * bot 的独立凭据（ApiToken · kind:'bot'）的展示口径与发放请求体。纯函数，不碰 DOM。
 * 单测在 bot-credential.test.ts。
 *
 * 契约（packages/contract/src/api-tokens.ts）：
 * - bot 列表里 `BotDto.token` 是它已签发的那条，null = 还没发过；
 * - 发放走 POST /api/tokens，多带 kind:'bot' + projectId + botName，明文只回一次；
 * - 越界的权限范围后端会裁掉（不报错），projectId 必填，只有项目主人 / 管理员能发。
 *
 * 时间全部由调用方给 now（组件传 Date.now()，单测传固定值），这里不读时钟。
 */

/** 用得到的 token 字段；结构上兼容 `BotDto['token']`。 */
export interface BotTokenDto {
  readonly id: string;
  readonly prefix: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}

/**
 * 发放时申请的权限。只能在自己项目里做事，所以不给项目 / 任务的写权限，
 * 也不给任何机器、提供商、资产相关的权限；后端还会再和 BOT_PERMISSIONS 取交集。
 */
export const BOT_CREDENTIAL_SCOPES = [
  'projects:read',
  'sessions:write',
  'groups:write',
  'files:read',
  'memory:read'
] as const;

export type BotCredentialScope = (typeof BOT_CREDENTIAL_SCOPES)[number];

/** 未签发时的一句话说明。 */
export const BOT_CREDENTIAL_HINT =
  '发放后它就能用 Authorization: Bearer <凭据> 调 /openapi/v1，只能访问这个项目。';

/** 已签发时的补充说明（状态行已经把前缀和用量摆出来了）。 */
export const BOT_CREDENTIAL_ACTIVE_NOTE = '它用这条凭据调开放 API，只能在这个项目里做事。';

export type BotCredentialView =
  | { readonly state: 'none'; readonly hint: string }
  | {
      readonly state: 'issued';
      readonly id: string;
      readonly prefix: string;
      /** 例：创建于 2026-11-13 09:05 */
      readonly created: string;
      /** 例：最近使用 3 分钟前 / 还没用过 */
      readonly lastUsed: string;
    };

const pad = (value: number) => String(value).padStart(2, '0');

/** 本地时间戳，精确到分钟：2026-11-13 09:05。toLocaleString 依赖 locale / 时区，测试不好固定。 */
export function stampText(ms: number): string {
  const at = new Date(ms);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 最近使用：一周以内说相对时间（刚发凭据的人更关心「还活着吗」），再久就直接给日期。
 * 没成文过（null）就说「还没用过」，别写成「—」——那读起来像故障。
 */
export function usedText(lastUsedAt: number | null, now: number): string {
  if (lastUsedAt === null) return '还没用过';
  const gap = now - lastUsedAt;
  if (gap < MINUTE) return '刚刚用过';
  if (gap < HOUR) return `${Math.floor(gap / MINUTE)} 分钟前用过`;
  if (gap < DAY) return `${Math.floor(gap / HOUR)} 小时前用过`;
  if (gap < 7 * DAY) return `${Math.floor(gap / DAY)} 天前用过`;
  return `${stampText(lastUsedAt)} 用过`;
}

/** bot.token → 状态 + 文案。 */
export function botCredentialView(token: BotTokenDto | null | undefined, now: number): BotCredentialView {
  if (!token) return { state: 'none', hint: BOT_CREDENTIAL_HINT };
  return {
    state: 'issued',
    id: token.id,
    prefix: token.prefix,
    created: `创建于 ${stampText(token.createdAt)}`,
    lastUsed: usedText(token.lastUsedAt, now)
  };
}

/** 吊销前的二次确认：说清后果（正在用它的脚本会立刻失效）。 */
export const botCredentialRevokeConfirm = (botName: string) =>
  `吊销 @${botName} 的凭据？正在用它的脚本会立刻失效。`;

export const BOT_CREDENTIAL_NAME_MAX = 60;
const NAME_SUFFIX = ' 的凭据';

/**
 * 令牌名：后端要求 1–60 字，列表里按名字区分，所以带上 bot 的 @id。
 * 按码点截断，别把 emoji 切成半个。
 */
export function botCredentialName(botName: string): string {
  const name = botName.trim();
  if (!name) return 'bot 的凭据';
  const room = BOT_CREDENTIAL_NAME_MAX - [...NAME_SUFFIX].length;
  return `${[...name].slice(0, room).join('')}${NAME_SUFFIX}`;
}

export interface BotCredentialBody {
  readonly name: string;
  readonly kind: 'bot';
  readonly projectId: string;
  readonly botName: string;
  readonly scopes: readonly BotCredentialScope[];
}

/** POST /api/tokens 的请求体。botName 是 bot 的 @id，后端拿它把凭据绑到这条 bot 上。 */
export function botCredentialBody(projectId: string, botName: string): BotCredentialBody {
  const name = botName.trim();
  return { name: botCredentialName(name), kind: 'bot', projectId, botName: name, scopes: BOT_CREDENTIAL_SCOPES };
}
