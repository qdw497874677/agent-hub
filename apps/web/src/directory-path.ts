/** 目录选择器的纯计算：面包屑。放在组件外，方便单测。 */

export interface Crumb {
  readonly label: string;
  readonly path: string;
}

/**
 * 当前路径 → 面包屑。从包含它的那个 root 开始（不能往 root 上面走）；
 * 不在任何 root 里（本机手动打进来的路径）就从 `/` 开始。
 */
export function breadcrumbs(path: string, roots: readonly string[]): Crumb[] {
  const clean = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  const current = clean(path);
  const root = [...roots]
    .map(clean)
    .filter((r) => current === r || current.startsWith(r === '/' ? '/' : `${r}/`))
    .sort((a, b) => b.length - a.length)[0];
  const base = root ?? '/';
  const crumbs: Crumb[] = [{ label: rootLabel(base), path: base }];
  const rest = current.slice(base === '/' ? 1 : base.length).split('/').filter(Boolean);
  let walked = base === '/' ? '' : base;
  for (const part of rest) {
    walked = `${walked}/${part}`;
    crumbs.push({ label: part, path: walked });
  }
  return crumbs;
}

function rootLabel(root: string): string {
  if (root === '/') return '/';
  const home = /^\/(home\/[^/]+|root|Users\/[^/]+)$/.test(root);
  return home ? '~' : (root.split('/').filter(Boolean).at(-1) ?? root);
}
