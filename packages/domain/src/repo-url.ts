/**
 * 比较两个仓库地址是不是同一个（远端 / 项目清单里可能一个带令牌、一个不带，或者 .git 有无差别）。
 * 去掉 userinfo、末尾 `.git` 与斜杠，主机与路径都按小写比。
 * 解析不了的（SSH、本地路径）只做 trim 后的精确比较。
 */
export function sameRepoUrl(a: string, b: string): boolean {
  const left = normalizeRepoUrl(a);
  const right = normalizeRepoUrl(b);
  return left !== null && right !== null && left === right;
}

/** 规范化失败（空串 / 无法解析）时返回 trim 后的原文，供「非 http 地址仍能精确比对」。 */
export function normalizeRepoUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
    return `${url.hostname.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return trimmed.replace(/\/+$/, '').replace(/\.git$/i, '');
  }
}
