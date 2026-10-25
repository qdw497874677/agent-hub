import type { DomainError } from './errors.ts';
import { invalid } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/**
 * 对话附件。三种来源，过 ACP 时各自对应一种 content block：
 *
 * - `image`：粘贴 / 拖入 / 拍照的图片 → ACP `image` block（Pi 的 `images` 字段）。
 * - `file`：上传的非图片文件 → 落进项目的 `.agent-hub/attachments/<session>/`，
 *   agent 支持 embeddedContext 且是文本时内嵌为 `resource`，否则给 `resource_link`。
 * - `mention`：`@` 引用项目里已有的文件 → `resource_link`，内容由 agent 自己去读。
 *
 * 上传的内容不进 journal：journal 只记元数据（`StoredAttachment`），
 * 文件本体落在项目目录里，专注对话按路径回取缩略图。
 */
export type AttachmentInput =
  | { readonly kind: 'image'; readonly name: string; readonly mimeType: string; readonly data: string }
  | { readonly kind: 'file'; readonly name: string; readonly mimeType: string; readonly data: string }
  | { readonly kind: 'mention'; readonly path: string };

/** journal 里留下的那一份：没有字节，只有「是什么、在哪」。path 相对项目根。 */
export interface StoredAttachment {
  readonly kind: 'image' | 'file' | 'mention';
  readonly name: string;
  readonly path: string;
  readonly mimeType?: string;
  readonly bytes?: number;
}

/** 发给 worker 的那一份：上传的带 base64，引用的给绝对路径。 */
export type PromptPart =
  | { readonly kind: 'image'; readonly name: string; readonly mimeType: string; readonly data: string; readonly path: string }
  | { readonly kind: 'file'; readonly name: string; readonly mimeType: string; readonly data: string; readonly path: string }
  | { readonly kind: 'mention'; readonly name: string; readonly path: string };

export interface PromptInput {
  readonly text: string;
  readonly parts: readonly PromptPart[];
}

export const ATTACHMENT_LIMITS = {
  maxCount: 8,
  imageBytes: 5 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 10 * 1024 * 1024
} as const;

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** base64 解出来有多少字节（不真解码，省一次大分配）。 */
export function base64Bytes(data: string): number {
  const clean = data.replace(/\s/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/** 只认项目内的相对路径：绝对路径、`..` 跳出、空段都拒。 */
export function isSafeRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** 上传文件名只留安全字符，再截短；防止目录穿越也防止奇怪的文件名进磁盘。 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').replace(/^\.+/, '');
  return (cleaned === '' ? 'file' : cleaned).slice(0, 80);
}

const MB = 1024 * 1024;

/** 大小、数量、类型的校验都在这里：前端会先挡一遍，但真正的关口在服务端。 */
export function validateAttachments(inputs: readonly AttachmentInput[]): Result<void, DomainError> {
  if (inputs.length > ATTACHMENT_LIMITS.maxCount) {
    return err(invalid(`一次最多 ${ATTACHMENT_LIMITS.maxCount} 个附件`));
  }
  let total = 0;
  for (const input of inputs) {
    if (input.kind === 'mention') {
      if (!isSafeRelativePath(input.path)) return err(invalid(`引用路径必须在项目内：${input.path}`));
      continue;
    }
    const bytes = base64Bytes(input.data);
    if (bytes === 0) return err(invalid(`附件是空的：${input.name}`));
    if (input.kind === 'image') {
      if (!(IMAGE_MIME_TYPES as readonly string[]).includes(input.mimeType)) {
        return err(invalid(`不支持的图片格式：${input.mimeType}（支持 PNG / JPEG / GIF / WebP）`));
      }
      if (bytes > ATTACHMENT_LIMITS.imageBytes) {
        return err(invalid(`图片 ${input.name} 超过 ${ATTACHMENT_LIMITS.imageBytes / MB}MB`));
      }
    } else if (bytes > ATTACHMENT_LIMITS.fileBytes) {
      return err(invalid(`文件 ${input.name} 超过 ${ATTACHMENT_LIMITS.fileBytes / MB}MB`));
    }
    total += bytes;
  }
  if (total > ATTACHMENT_LIMITS.totalBytes) {
    return err(invalid(`附件合计超过 ${ATTACHMENT_LIMITS.totalBytes / MB}MB`));
  }
  return ok(undefined);
}

/** 上传附件在项目里的落点（相对项目根）。按会话分目录，序号前缀避免重名覆盖。 */
export function attachmentPath(sessionId: string, index: number, at: number, name: string): string {
  return `.agent-hub/attachments/${sessionId}/${at}-${index}-${safeFileName(name)}`;
}
