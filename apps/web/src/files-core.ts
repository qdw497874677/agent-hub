/** 文件浏览里不碰 DOM 的小规则（ADR 0025）：好测。 */

export function crumbs(path: string): { name: string; path: string }[] {
  const parts = path === '' ? [] : path.split('/');
  return [{ name: '根目录', path: '' }, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))];
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
  cs: 'csharp', swift: 'swift', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'toml', html: 'html',
  css: 'css', scss: 'scss', sql: 'sql', xml: 'xml', vue: 'vue', svelte: 'svelte', lua: 'lua', dockerfile: 'dockerfile'
};

/** 按扩展名猜 Shiki 语言；猜不到就是纯文本（不高亮）。 */
export function languageOf(path: string): string | null {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'make';
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : '';
  return LANG[ext] ?? null;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function decodeText(base64: string): string {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 要盯的路径：展开着的目录（各一层）+ 打开的文件，最多 200 个（决定 3）。 */
export function watchPaths(expanded: Iterable<string>, open: string | null): string[] {
  const set = new Set<string>(expanded);
  if (open !== null) set.add(open);
  return [...set].sort().slice(0, 200);
}

/** 一次变化通知是否影响某个目录的列表：目录本身或它的直接子项变了。 */
export function touches(dir: string, changed: readonly string[]): boolean {
  return changed.some((p) => p === dir || parentOf(p) === dir);
}

export const GIT_LABEL: Record<string, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!', ignored: '' };
