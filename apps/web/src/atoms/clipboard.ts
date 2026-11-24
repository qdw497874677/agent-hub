/**
 * 浏览器剪贴板只有一条可靠的路：安全上下文里的 navigator.clipboard。
 * 普通 HTTP（内网 / tailnet 常见）下它根本不存在，权限被拒时 writeText 也会 reject。
 * 这两种情况都如实返回 manual，交给调用方把同一段文字摊出来让人自己选——
 * 绝不装作写进去了，也不碰已经废弃的 execCommand。
 */
export type CopyOutcome = 'copied' | 'manual';

export interface ClipboardLike {
  writeText(text: string): Promise<unknown>;
}

/** 当前环境能用的原生剪贴板；没有就返回 null。每次调用时再看，不在模块加载时缓存。 */
export function clipboardLike(): ClipboardLike | null {
  try {
    if (typeof navigator === 'undefined') return null;
    const clipboard = (navigator as Navigator & { clipboard?: ClipboardLike }).clipboard;
    return clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === 'function' ? clipboard : null;
  } catch {
    return null;
  }
}

/** 只写原生剪贴板：没有接口、同步抛错、异步拒绝，一律返回 manual。 */
export async function copyText(value: string, clipboard: ClipboardLike | null = clipboardLike()): Promise<CopyOutcome> {
  if (clipboard === null) return 'manual';
  try {
    await clipboard.writeText(value);
    return 'copied';
  } catch {
    return 'manual';
  }
}
