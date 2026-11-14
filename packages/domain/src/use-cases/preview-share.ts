import type { Subject } from '../access.ts';
import { invalid, notFound, type DomainError } from '../errors.ts';
import type { PreviewLinkId } from '../ids.ts';
import {
  PREVIEW_SHARE_DEFAULT_HOURS,
  PREVIEW_SHARE_MAX_HOURS,
  PREVIEW_SHARE_PREFIX,
  type PreviewLink,
} from '../preview.ts';
import type { PreviewLinkRepository } from '../ports/preview-links.ts';
import { err, ok, type Result } from '../result.ts';
import { terminalTarget, type TerminalTargetDeps } from './terminal.ts';

/**
 * 预览的公开分享（docs/design/preview.md §4）。
 *
 * 令牌只存 sha256：库里泄漏拿不到可用链接；分享 = 轮换，重新分享会覆盖旧哈希，
 * 旧令牌立刻失效。`shared` 不落库，由「有哈希且未过期」现算。
 */
export type PreviewShareDeps = TerminalTargetDeps & {
  readonly previewLinks: PreviewLinkRepository;
  readonly now: () => number;
};

export interface SharePreviewCommand {
  readonly sessionId: string;
  readonly linkId: string;
  /** 有效期（小时），默认 24，上限 720。 */
  readonly hours?: number;
}

export interface PreviewShareGrant {
  readonly link: PreviewLink;
  /** 明文令牌，只在分享这一次返回。 */
  readonly token: string;
  readonly expiresAt: number;
}

const HOUR_MS = 3_600_000;
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 24 字节 → 32 个 base64url 字符，不补 `=`。 */
function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += B64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += B64URL[b2 & 0x3f];
  }
  return out;
}

/**
 * sha256 hex。用 Web Crypto（Node 与浏览器都有）而不是 `node:crypto`：
 * 领域层不允许 import 平台模块（`purity.test.ts`）。
 */
async function hashOfToken(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `pvs_` + 24 字节随机数的 base64url。 */
export function newPreviewShareToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return `${PREVIEW_SHARE_PREFIX}${base64url(bytes)}`;
}

/** 令牌 → 落库的 sha256 hex（代理层校验与这里必须一致）。 */
export function previewShareTokenHash(token: string): Promise<string> {
  return hashOfToken(token);
}

/** 恒定时间比较两个 hex 哈希；长度不同直接否。 */
function sameHash(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0 && expected.length > 0;
}

/** 公开形状：`shared` / `shareExpiresAt` 按当前时间现算，绝不回传哈希。 */
export interface PreviewLinkPublic {
  readonly id: PreviewLinkId;
  readonly sessionId: PreviewLink['sessionId'];
  readonly workerId: string;
  readonly port: number;
  readonly hubPort: number;
  readonly label: string;
  readonly source: PreviewLink['source'];
  readonly state: PreviewLink['state'];
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly shared: boolean;
  readonly shareExpiresAt: number | null;
}

export function previewLinkPublic(
  deps: Pick<PreviewShareDeps, 'now'>,
  link: PreviewLink,
): PreviewLinkPublic {
  const expiresAt = link.shareExpiresAt ?? null;
  const hash = link.shareTokenHash ?? null;
  return {
    id: link.id,
    sessionId: link.sessionId,
    workerId: link.workerId,
    port: link.port,
    hubPort: link.hubPort,
    label: link.label,
    source: link.source,
    state: link.state,
    createdAt: link.createdAt,
    lastSeenAt: link.lastSeenAt,
    shared: hash !== null && hash !== '' && expiresAt !== null && expiresAt > deps.now(),
    shareExpiresAt: expiresAt,
  };
}

/**
 * 分享一条预览链接（重新分享 = 轮换令牌，旧的立刻失效）。
 * 鉴权同预览本身：走 `session.read`，别的会话/不存在一律 404。
 */
export async function sharePreviewLinkUseCase(
  deps: PreviewShareDeps,
  subject: Subject | null,
  command: SharePreviewCommand,
): Promise<Result<PreviewShareGrant, DomainError>> {
  const link = await deps.previewLinks.byId(command.linkId as PreviewLinkId);
  if (link === null || link.sessionId !== command.sessionId) return err(notFound('预览链接不存在'));

  const target = await terminalTarget(deps, subject, command.sessionId);
  if (!target.ok) return target;

  const hours = command.hours ?? PREVIEW_SHARE_DEFAULT_HOURS;
  if (!Number.isInteger(hours) || hours < 1 || hours > PREVIEW_SHARE_MAX_HOURS) {
    return err(invalid(`分享有效期要在 1–${PREVIEW_SHARE_MAX_HOURS} 小时之间`));
  }

  const token = newPreviewShareToken();
  const expiresAt = deps.now() + hours * HOUR_MS;
  const saved: PreviewLink = {
    ...link,
    shareTokenHash: await hashOfToken(token),
    shareExpiresAt: expiresAt,
  };
  await deps.previewLinks.save(saved);
  return ok({ link: saved, token, expiresAt });
}

/** 撤销分享；已撤销再撤销也算成功（幂等）。 */
export async function revokePreviewShareUseCase(
  deps: PreviewShareDeps,
  subject: Subject | null,
  command: { readonly sessionId: string; readonly linkId: string },
): Promise<Result<PreviewLink, DomainError>> {
  const link = await deps.previewLinks.byId(command.linkId as PreviewLinkId);
  if (link === null || link.sessionId !== command.sessionId) return err(notFound('预览链接不存在'));

  const target = await terminalTarget(deps, subject, command.sessionId);
  if (!target.ok) return target;

  const cleared: PreviewLink = { ...link, shareTokenHash: null, shareExpiresAt: null };
  await deps.previewLinks.save(cleared);
  return ok(cleared);
}

export type PreviewShareMatch =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'notfound' | 'expired' };

/**
 * 代理层用：判断 `?share=` 令牌是否还能放行这条链接。
 * 只做哈希比较，不碰会话/账号。
 */
export async function matchPreviewShare(
  deps: Pick<PreviewShareDeps, 'previewLinks'>,
  linkId: string,
  token: string,
  now: number,
): Promise<PreviewShareMatch> {
  const link = await deps.previewLinks.byId(linkId as PreviewLinkId);
  const hash = link?.shareTokenHash ?? null;
  const expiresAt = link?.shareExpiresAt ?? null;
  if (link === null || hash === null || hash === '' || expiresAt === null) {
    return { ok: false, reason: 'notfound' };
  }
  if (expiresAt <= now) return { ok: false, reason: 'expired' };
  if (!sameHash(hash, await hashOfToken(token))) return { ok: false, reason: 'notfound' };
  return { ok: true };
}
