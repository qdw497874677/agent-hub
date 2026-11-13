/** 文件浏览里不碰 DOM 的小规则（ADR 0025）：好测。 */

/**
 * 文件查询的缓存策略（stale-while-revalidate）：切回标签先显示缓存，同时后台重新读一遍。
 * staleTime 0 = 每次挂载 / 失效都重读；gcTime 保留 10 分钟供切回时立即显示。
 * ADR 0025 决定 8 仍成立：重读失败（机器离线）时不显示旧数据，界面一律 error 优先——见 shown()。
 */
export const FILES_QUERY = { retry: false, gcTime: 10 * 60_000, staleTime: 0, refetchOnWindowFocus: false } as const;

/**
 * 目录列表必须丢掉进行中的旧结果再读。返回时文件已经建好，但请求是在那之前发出的，
 * 再碰上「有请求在飞就不再读」就会一直显示旧目录。
 * diff 和改动数正在读时不能取消，否则切轮次会停在空表。
 */
export function filesRefetch(kind: string): { cancelRefetch: boolean } {
  return { cancelRefetch: kind === 'list' };
}

/**
 * 文件接口的 503。只有正文写明这台机器不在线，才收成「机器离线」。
 * 限流、超时（没有及时回复）、通道尚未就绪、git 自己的失败都留原文。
 * 这些都是 503，收成同一句会把「机器断了」和「还在、只是没及时回」混在一起。
 */
export function filesErrorText(status: number, message: string | undefined): string {
  const text = typeof message === 'string' ? message : '';
  if (status === 503 && text.includes('不在线')) return '机器离线';
  return text;
}

/** 有错误就不给数据：离线显示离线，不拿缓存冒充当前。 */
export function shown<Q extends { data?: unknown; error: unknown }>(query: Q): Q['data'] | undefined {
  return query.error ? undefined : query.data;
}

export function crumbs(path: string): { name: string; path: string }[] {
  const parts = path === '' ? [] : path.split('/');
  return [{ name: '根目录', path: '' }, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))];
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * 路径的紧凑写法：放得下就给全文，放不下就留末尾几段、中间省略（`…/workspace/agent-hub`）。
 * 工作空间根路径通常很长，窄屏只留得住尾巴；保留开头会看不出是哪一层。
 */
export function shortPath(path: string, max = 32): string {
  if (path.length <= max) return path;
  const prefix = '…/';
  const parts = path.split('/').filter((part) => part !== '');
  const budget = Math.max(max - prefix.length, 1);
  const tail: string[] = [];
  let size = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const name = parts[i] ?? '';
    const next = size === 0 ? name.length : size + 1 + name.length;
    if (tail.length > 0 && next > budget) break;
    tail.unshift(name);
    size = next;
  }
  return `${prefix}${tail.join('/')}`;
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
