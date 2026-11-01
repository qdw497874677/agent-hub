import type { MemoryEntry, MemoryKind, MemoryScope, MemoryStatus, MemoryTrust, ProjectMemoryMode, SourceRef } from '../memory.ts';

/**
 * 记忆端口（ADR 0019 §4）。hub 自带的 SQLite / FTS5 只是默认适配器；
 * use case、MCP 工具、界面都只调这些端口，不碰 memory_* 表。换 Mem0 / Zep 只换适配器。
 */

/** —— 整理出来的条目：可写 —— */
export interface MemoryEntryFilter {
  readonly status?: readonly MemoryStatus[];
  readonly kinds?: readonly MemoryKind[];
  readonly limit?: number;
}
export interface MemoryStore {
  readonly id: string;
  put(entry: MemoryEntry): Promise<void>;
  /** 乐观锁：库里的 version 不是 ifVersion 就返回 null（被别人改过了）。旧版本存进历史。 */
  update(entry: MemoryEntry, ifVersion: number): Promise<MemoryEntry | null>;
  get(id: string): Promise<MemoryEntry | null>;
  /** 新的在前。 */
  /** scopes = null：所有作用域（只给后台整理用）。 */
  list(scopes: readonly MemoryScope[] | null, filter?: MemoryEntryFilter): Promise<MemoryEntry[]>;
  /** 出处里引用了这个 uri 的条目（来源变了要标 stale）。 */
  citing(source: string, uri: string): Promise<MemoryEntry[]>;
  /** 一条的历史版本，旧的在前。 */
  history(id: string): Promise<MemoryEntry[]>;
  /** 硬删除（memory.purge）：连历史一起删。软删除走 update(status = forgotten)。 */
  purge(id: string): Promise<void>;
  /** 自带检索的存储（Mem0、Zep）实现它；没有就靠 MemoryIndex。 */
  search?(query: MemoryQuery): Promise<MemoryHit[]>;
}

/** —— 来源：就地索引，只读 —— */
export interface SourceDoc {
  readonly ref: SourceRef & { readonly hash: string };
  readonly title: string;
  /** 用来建索引的文字；适配器可以截断。 */
  readonly text: string;
  readonly updatedAt: number;
}
export interface SourceChanges {
  /** 当前全部文档（P1 的来源都小：全量列、按哈希比增量）。 */
  readonly docs: readonly SourceDoc[];
  /** 列不全（机器离线、文件太多）：没列到的不要当成删除。 */
  readonly partial: boolean;
}
export interface MemorySource {
  readonly id: string;
  readonly scopeKinds: readonly MemoryScope['kind'][];
  /** 这个作用域下的文档。 */
  scan(scope: MemoryScope): Promise<SourceChanges>;
  /** 要用时再读正文。 */
  read(scope: MemoryScope, ref: SourceRef): Promise<{ text: string; hash: string } | null>;
  search?(query: MemoryQuery): Promise<MemoryHit[]>;
}

/** —— 索引：给没有自带检索的来源 / 存储用（FTS5） —— */
export interface IndexDoc {
  /** 'entry:<id>' 或 'src:<source>:<uri>'。 */
  readonly key: string;
  readonly scopeKey: string;
  readonly origin: 'entry' | 'source';
  readonly title: string;
  readonly text: string;
  readonly kind: MemoryKind | null;
  readonly trust: MemoryTrust;
  readonly updatedAt: number;
  readonly ref: SourceRef | null;
}
export interface IndexHit {
  readonly key: string;
  readonly scopeKey: string;
  readonly origin: 'entry' | 'source';
  readonly title: string;
  readonly snippet: string;
  /** 越大越相关（已经归一到 0–1）。 */
  readonly relevance: number;
  readonly trust: MemoryTrust;
  readonly updatedAt: number;
  readonly ref: SourceRef | null;
}
export interface MemoryIndex {
  upsert(docs: readonly IndexDoc[]): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
  /** 某个作用域下某个来源已经索引过的文档（key → hash），给增量和「来源变了」用。 */
  indexed(scopeKey: string, source: string): Promise<Map<string, string>>;
  query(query: { readonly text: string; readonly scopeKeys: readonly string[]; readonly origins: readonly ('entry' | 'source')[]; readonly kinds?: readonly MemoryKind[]; readonly limit: number }): Promise<IndexHit[]>;
}

/** —— 检索 —— */
export interface MemoryQuery {
  readonly text: string;
  readonly scopes: readonly MemoryScope[];
  readonly kinds?: readonly MemoryKind[];
  readonly include?: readonly ('entries' | 'sources')[];
  readonly limit: number;
}
export interface MemoryHit {
  readonly key: string;
  readonly origin: 'entry' | 'source';
  readonly scopeKey: string;
  readonly score: number;
  readonly title: string;
  readonly snippet: string;
  readonly trust: MemoryTrust;
  readonly updatedAt: number;
  readonly entryId?: string;
  readonly ref?: SourceRef;
}
export interface MemoryRetriever {
  retrieve(query: MemoryQuery): Promise<MemoryHit[]>;
}

/** —— 策略：可替换 —— */
export interface WriteContext {
  readonly author: 'human' | 'agent';
  /** 写的是不是「自己的」作用域：本人的 user、本会话的 session、本角色的 role。 */
  readonly own: boolean;
  /** 写的人能不能审核这个作用域（有 memory.review）。 */
  readonly canReview: boolean;
  readonly projectMode: ProjectMemoryMode;
}
export interface WriteDecision {
  readonly action: 'accept' | 'review' | 'reject';
  readonly reason?: string;
}
export interface MemoryPolicy {
  onWrite(entry: Pick<MemoryEntry, 'scope' | 'kind' | 'title' | 'body'>, ctx: WriteContext): Promise<WriteDecision>;
}

/** —— 设置：每个项目的写入模式 —— */
export interface MemorySettingsStore {
  projectMode(projectId: string): Promise<ProjectMemoryMode>;
  setProjectMode(projectId: string, mode: ProjectMemoryMode, at: number): Promise<void>;
  /** 会后提炼用哪个模型（hub-<slug>/<model>；null = 规则版）。ADR 0024。 */
  distillModel(projectId: string): Promise<string | null>;
  setDistillModel(projectId: string, model: string | null, at: number): Promise<void>;
  /** 项目级提炼开关（默认开；全局 HUB_MEMORY_DISTILL=0 优先）。 */
  distillEnabled(projectId: string): Promise<boolean>;
  setDistillEnabled(projectId: string, enabled: boolean, at: number): Promise<void>;
}

/* ——— P2 重构：每一块一个端口，适配器经注册表装配（见 memory.md §16） ——— */

/** 写入路径：提炼器。规则版是默认适配器；模型版以后作为另一个适配器注册，不改服务。 */
export interface DistillInput {
  readonly summary: string;
  readonly sessionId: string;
  readonly seq: number;
  /** 会话所属项目：模型版提炼器按项目设置挑模型、记用量。 */
  readonly projectId: string;
}
export interface MemoryDistiller {
  readonly id: string;
  /** 返回候选：第一条是摘要本身（进 session:），其余是项目层候选。返回空 = 不写（比如含密钥）。 */
  distill(input: DistillInput): Promise<readonly import('../memory.ts').DistillCandidate[]>;
}

/** 检索路径：多路结果怎么融合排序（默认 RRF k=60）。 */
export interface MemoryRanker {
  readonly id: string;
  fuse(lists: readonly (readonly MemoryHit[])[]): MemoryHit[];
}

/** 定期维护：每个任务一个适配器（过期物化、每周抽查、以后的过时检测 / 整理）。sweep 依次跑注册的任务。 */
export interface MaintenanceContext {
  readonly now: number;
  readonly store: MemoryStore;
  readonly index: MemoryIndex;
  /** 条目 → 索引文档（服务给的，任务不用知道索引格式）。 */
  readonly indexDoc: (entry: MemoryEntry) => IndexDoc;
}
export interface MemoryMaintenanceJob {
  readonly id: string;
  run(ctx: MaintenanceContext): Promise<{ readonly count: number }>;
}

/** 治理：密钥过滤（命中返回类别名，没命中 null）。写入、导入、提炼都过它。 */
export interface MemorySecretFilter {
  readonly id: string;
  check(text: string): string | null;
}
