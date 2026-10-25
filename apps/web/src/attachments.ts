import type { AttachmentInputDto, CapabilityDto } from '@agent-hub/contract';

/**
 * 输入框里的附件与命令：纯逻辑都在这里，composer.tsx 只管手势和渲染。
 *
 * 上限与 domain 的 ATTACHMENT_LIMITS 一致。服务端才是裁判；
 * 这里提前拦一次只是为了别让人等一个 5MB 的上传失败才知道超了。
 */
export const LIMITS = {
  maxCount: 8,
  imageBytes: 5 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 10 * 1024 * 1024
} as const;

export const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** 还没发出去的一项：界面上是一个小卡片，发送时变成 AttachmentInputDto。 */
export type Draft =
  | { readonly kind: 'image' | 'file'; readonly id: string; readonly name: string; readonly mimeType: string; readonly data: string; readonly bytes: number; readonly preview?: string }
  | { readonly kind: 'mention'; readonly id: string; readonly path: string };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 加一项之前问一句：放得下吗？放不下就给人能看懂的理由。 */
export function checkAdd(current: readonly Draft[], next: { kind: 'image' | 'file'; name: string; bytes: number }): string | null {
  if (current.length >= LIMITS.maxCount) return `最多 ${LIMITS.maxCount} 个附件`;
  const cap = next.kind === 'image' ? LIMITS.imageBytes : LIMITS.fileBytes;
  if (next.bytes > cap) return `${next.name} 超过 ${formatBytes(cap)}`;
  const total = current.reduce((sum, item) => sum + (item.kind === 'mention' ? 0 : item.bytes), 0) + next.bytes;
  if (total > LIMITS.totalBytes) return `附件合计超过 ${formatBytes(LIMITS.totalBytes)}`;
  return null;
}

export function toInput(draft: Draft): AttachmentInputDto {
  if (draft.kind === 'mention') return { kind: 'mention', path: draft.path };
  return { kind: draft.kind, name: draft.name, mimeType: draft.mimeType, data: draft.data };
}

let counter = 0;
export const nextId = (): string => `a${Date.now().toString(36)}${(counter++).toString(36)}`;

export const mentionDraft = (path: string): Draft => ({ kind: 'mention', id: nextId(), path });

/** 光标前面那个 `@xxx` / 行首 `/xxx`：决定弹不弹选择器、拿什么去搜。 */
export function triggerAt(text: string, caret: number): { kind: '@' | '/'; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const mention = /(^|\s)@([^\s@]*)$/.exec(before);
  if (mention) return { kind: '@', query: mention[2] ?? '', start: caret - (mention[2]?.length ?? 0) - 1 };
  const command = /^\/([\w-]*)$/.exec(before);
  if (command) return { kind: '/', query: command[1] ?? '', start: 0 };
  return null;
}

export interface SlashCommand {
  readonly name: string;
  readonly hint: string;
  readonly run: () => Promise<unknown>;
}

export const filterCommands = (commands: readonly SlashCommand[], query: string): SlashCommand[] =>
  commands.filter((command) => command.name.startsWith(query.toLowerCase()));

/** 附件能力没写就当可用（老 worker 没报这一项）。 */
export const attachmentsCapability = (capabilities: Partial<Record<string, CapabilityDto>> | undefined): CapabilityDto =>
  capabilities?.['attachments'] ?? { state: 'available' };
