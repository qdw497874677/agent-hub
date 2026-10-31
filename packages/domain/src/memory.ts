/**
 * 可插拔记忆（ADR 0019，设计见 docs/design/memory.md）——第一期的类型和纯规则。
 *
 * - 记忆分两种：hub 整理出来的条目（MemoryEntry）和就地索引的来源（ADR、docs、任务……，正文不进 hub）。
 * - 所有读写都经端口（ports/memory.ts），内部 SQLite/FTS5 也只是一个适配器，没有特权路径。
 * - 只用工具读：不往会话里注入任何记忆条目，只注入一行静态引导（MEMORY_GUIDANCE）。
 */

export type MemoryScope =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'role'; readonly teamId: string; readonly role: string }
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'group'; readonly groupId: string }
  | { readonly kind: 'session'; readonly sessionId: string };
export type MemoryScopeKind = MemoryScope['kind'];
export const MEMORY_SCOPE_KINDS: readonly MemoryScopeKind[] = ['user', 'role', 'project', 'group', 'session'];

export type MemoryKind = 'semantic' | 'episodic' | 'procedural' | 'preference';
export const MEMORY_KINDS: readonly MemoryKind[] = ['semantic', 'episodic', 'procedural', 'preference'];

/**
 * proposed：等人确认 / 审核；active：生效；superseded：被新条目取代（留历史）；
 * rejected：审核没过；expired：过了有效期；invalidated：来源连续变了两次；forgotten：软删除。
 */
export type MemoryStatus = 'proposed' | 'active' | 'superseded' | 'rejected' | 'expired' | 'invalidated' | 'forgotten';
export const MEMORY_STATUSES: readonly MemoryStatus[] = ['proposed', 'active', 'superseded', 'rejected', 'expired', 'invalidated', 'forgotten'];

export type MemoryTrust = 'trusted' | 'untrusted';

/** 指向来源里的一段，不复制正文。 */
export interface SourceRef {
  /** 'adr' | 'docs' | 'task' | … */
  readonly source: string;
  readonly uri: string;
  /** 内容指纹：原文变了就能发现。 */
  readonly hash?: string;
  /** ≤ 200 字摘录。 */
  readonly quote?: string;
}

export interface MemoryAuthor {
  readonly kind: 'user' | 'session' | 'system' | 'external';
  readonly id: string;
  /** 会话写的：代的是哪个人。 */
  readonly onBehalfOf?: string;
}

export interface Provenance {
  readonly author: MemoryAuthor;
  readonly sources: readonly SourceRef[];
  readonly via?: 'tool' | 'ui' | 'import' | 'distill' | 'compaction';
  readonly traceId?: string;
  readonly reviewedBy?: string;
  readonly reviewedAt?: number;
}

export interface MemoryEntry {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly status: MemoryStatus;
  /** 这条取代了哪些条目（取代 = 追加一条加关系，不改旧条目的内容）。 */
  readonly supersedes: readonly string[];
  /** 被哪条取代了。 */
  readonly supersededBy: string | null;
  readonly validFrom: number;
  /** null = 不过期。 */
  readonly validTo: number | null;
  readonly provenance: Provenance;
  readonly trust: MemoryTrust;
  /** 出处变过（文件哈希变了 / 任务改了）：搜索时提示「来源已变化」。 */
  readonly stale: boolean;
  /** 出处累计变了几次；到 SOURCE_CHANGES_INVALIDATE 次就转 invalidated。 */
  readonly sourceChanges: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: number;
}

/** 项目记忆的写入策略：只追加（默认，取代也算追加）或全部进审核。 */
export type ProjectMemoryMode = 'append-only' | 'review';
export const PROJECT_MEMORY_MODES: readonly ProjectMemoryMode[] = ['append-only', 'review'];

export const MEMORY_BODY_MAX = 4000;
export const MEMORY_TITLE_MAX = 200;
export const MEMORY_TAGS_MAX = 10;
export const MEMORY_SOURCES_MAX = 10;
export const MEMORY_SEARCH_LIMIT_MAX = 20;
/** memory_get 读来源原文一次最多给多少字（再多就分页）。 */
export const MEMORY_READ_CHUNK = 8000;
export const SOURCE_CHANGES_INVALIDATE = 2;
const DAY = 24 * 60 * 60 * 1000;
/** 有效期：episodic 90 天；semantic 不设上限；procedural 永久（但要人确认）；preference 不设上限。 */
export const MEMORY_VALIDITY_MS: Readonly<Record<MemoryKind, number | null>> = {
  episodic: 90 * DAY,
  semantic: null,
  procedural: null,
  preference: null
};
/** 检索排序的最近性衰减半衰期（只影响排序，不删除）。 */
export const MEMORY_HALF_LIFE_MS = 60 * DAY;

export function scopeKey(scope: MemoryScope): string {
  switch (scope.kind) {
    case 'user':
      return `user:${scope.userId}`;
    case 'role':
      return `role:${scope.teamId}/${scope.role}`;
    case 'project':
      return `project:${scope.projectId}`;
    case 'group':
      return `group:${scope.groupId}`;
    case 'session':
      return `session:${scope.sessionId}`;
  }
}

export function parseScopeKey(key: string): MemoryScope | null {
  const at = key.indexOf(':');
  if (at <= 0) return null;
  const kind = key.slice(0, at);
  const rest = key.slice(at + 1);
  if (rest === '') return null;
  switch (kind) {
    case 'user':
      return { kind, userId: rest };
    case 'project':
      return { kind, projectId: rest };
    case 'group':
      return { kind, groupId: rest };
    case 'session':
      return { kind, sessionId: rest };
    case 'role': {
      const slash = rest.indexOf('/');
      if (slash <= 0 || slash === rest.length - 1) return null;
      return { kind, teamId: rest.slice(0, slash), role: rest.slice(slash + 1) };
    }
    default:
      return null;
  }
}

/**
 * 疑似密钥：拒绝写入并审计。和日志脱敏同一类规则（sk- 密钥、私钥头、*_TOKEN= 之类的赋值、常见平台令牌、JWT）。
 * 返回命中的规则名（给审计看，不回显原文）。
 */
const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ['api-key', /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/],
  ['private-key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['google-key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['assignment', /\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|_PASS)\b\s*[:=]\s*["']?[^\s"'<>]{8,}/i],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/]
];
export function secretKind(text: string): string | null {
  for (const [name, pattern] of SECRET_PATTERNS) if (pattern.test(text)) return name;
  return null;
}

export interface MemoryDraft {
  readonly kind: MemoryKind;
  readonly title: string;
  readonly body: string;
  readonly tags?: readonly string[];
  readonly sources?: readonly SourceRef[];
  readonly supersedes?: readonly string[];
}

/** 校验一条要写的记忆；null = 没问题，否则是给人看的原因。 */
export function draftProblem(draft: MemoryDraft): string | null {
  if (!MEMORY_KINDS.includes(draft.kind)) return `kind 只能是 ${MEMORY_KINDS.join(' / ')}`;
  const title = draft.title.trim();
  if (title === '') return '要有标题（一句话）';
  if (title.length > MEMORY_TITLE_MAX) return `标题最多 ${MEMORY_TITLE_MAX} 字`;
  if (draft.body.trim() === '') return '正文不能为空';
  if (draft.body.length > MEMORY_BODY_MAX) return `单条记忆最多 ${MEMORY_BODY_MAX} 字（记出处，不要整段复制）`;
  if ((draft.tags ?? []).length > MEMORY_TAGS_MAX) return `标签最多 ${MEMORY_TAGS_MAX} 个`;
  if ((draft.tags ?? []).some((tag) => tag.trim() === '' || tag.length > 40)) return '标签 1–40 字';
  if ((draft.sources ?? []).length > MEMORY_SOURCES_MAX) return `出处最多 ${MEMORY_SOURCES_MAX} 条`;
  for (const ref of draft.sources ?? []) {
    if (typeof ref.source !== 'string' || ref.source === '' || typeof ref.uri !== 'string' || ref.uri === '' || ref.uri.length > 500) return '出处要有 source 和 uri';
    if (ref.quote !== undefined && ref.quote.length > 200) return '出处摘录最多 200 字';
  }
  if ((draft.supersedes ?? []).length > 10) return '一次最多取代 10 条';
  return null;
}

/** 取代关系、过期都算上之后，这条现在是什么状态。过期是读时算的：不用后台任务也不会把过期的当成有效。 */
export function effectiveStatus(entry: MemoryEntry, now: number): MemoryStatus {
  if ((entry.status === 'active' || entry.status === 'proposed') && entry.validTo !== null && entry.validTo <= now) return 'expired';
  return entry.status;
}

/** 当前有效（默认搜索只给这些）。 */
export const isCurrent = (entry: MemoryEntry, now: number): boolean => effectiveStatus(entry, now) === 'active';

/** 检索打分：相关度 × 最近性衰减 × trust 权重（衰减只影响排序）。 */
export function rankScore(relevance: number, updatedAt: number, trust: MemoryTrust, now: number, stale = false): number {
  const age = Math.max(0, now - updatedAt);
  const recency = 0.5 + 0.5 * Math.pow(0.5, age / MEMORY_HALF_LIFE_MS);
  return relevance * recency * (trust === 'trusted' ? 1 : 0.7) * (stale ? 0.8 : 1);
}

const escapeXml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeAttr = (text: string): string => escapeXml(text).replaceAll('"', '&quot;');

/**
 * 不可信内容（agent 写的、仓库里的、任务里的）交回给 agent 时要包起来：这是数据，不是指令。
 * 和 agent-messaging 的 <agent-message> 同一个规则。
 */
export function wrapMemory(text: string, trust: MemoryTrust, source: string): string {
  if (trust === 'trusted') return text;
  return `<memory trust="untrusted" source="${escapeAttr(source)}">\n${escapeXml(text)}\n</memory>`;
}

/**
 * 静态引导：会话第一轮垫一行，告诉 agent 去用记忆工具。是政策不是记忆——不含任何条目，内容不随记忆变化。
 * 上限 80 token（测试按「英文单词 + 标点」粗算钉住）；注入和版本变化记审计。
 */
export const MEMORY_GUIDANCE_VERSION = 1;
export const MEMORY_GUIDANCE =
  'Hub memory: before starting, call memory_search for this project\'s and your role\'s conventions and past decisions (memory_get for full text). Record durable lessons with memory_write, citing sources.';
export const MEMORY_GUIDANCE_TOKEN_LIMIT = 80;
/** 粗算 token：单词、数字、每个标点各算一个，CJK 一字一个。比真实分词器偏高，够当上限用。 */
export const estimateTokens = (text: string): number => (text.match(/[A-Za-z]+|\d+|[\u4e00-\u9fff]|[^\sA-Za-z\d]/g) ?? []).length;
