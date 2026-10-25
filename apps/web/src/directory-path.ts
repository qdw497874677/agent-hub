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

/** 输入框里的文本拆成「在哪个目录」和「正在筛的片段」：`/home/u/pro` → `/home/u` + `pro`。 */
export function splitInput(text: string): { dir: string; filter: string } {
  const index = text.lastIndexOf('/');
  if (index < 0) return { dir: '', filter: text };
  const dir = index === 0 ? '/' : text.slice(0, index);
  return { dir, filter: text.slice(index + 1) };
}

/** 目录 → 输入框文本（末尾带 `/`，接着打字就是在这层里筛）。 */
export function withSlash(dir: string): string {
  return dir.endsWith('/') ? dir : `${dir}/`;
}

/**
 * 子序列模糊匹配打分（越大越好，null = 不匹配）：前缀 > 连续 > 分散，大小写不敏感。
 * 和 VS Code / Zed 的路径补全一样只在当前这一层里筛，不递归扫盘。
 */
export function fuzzyScore(name: string, filter: string): number | null {
  if (filter === '') return 0;
  const n = name.toLowerCase();
  const f = filter.toLowerCase();
  if (n === f) return 1000;
  if (n.startsWith(f)) return 500 - n.length;
  const at = n.indexOf(f);
  if (at >= 0) return 300 - at;
  let score = 100;
  let from = 0;
  for (const ch of f) {
    const found = n.indexOf(ch, from);
    if (found < 0) return null;
    score -= found - from;
    from = found + 1;
  }
  return score;
}

/** 按模糊分排序筛选；不筛时保持原顺序（服务端已按最近修改排好）。 */
export function filterEntries<T extends { name: string }>(entries: readonly T[], filter: string): T[] {
  if (filter === '') return [...entries];
  return entries
    .map((entry) => ({ entry, score: fuzzyScore(entry.name, filter) }))
    .filter((x): x is { entry: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.entry);
}
