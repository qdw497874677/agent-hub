import { decide, DENY_MESSAGES, type AccessContext, type Permission, type Resource } from '../access.ts';
import type { AuditAction, Principal } from '../account.ts';
import { conflict, forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import { asProjectId, asSessionId, newId, type SessionId } from '../ids.ts';
import {
  DISTILL_LIMITS,
  distillSummary,
  secretKind,
  MEMORY_READ_CHUNK,
  STAGED_CORROBORATE_MS,
  normalizeTitle,
  MEMORY_SEARCH_LIMIT_MAX,
  MEMORY_VALIDITY_MS,
  SOURCE_CHANGES_INVALIDATE,
  draftProblem,
  effectiveStatus,
  isCurrent,
  parseScopeKey,
  rankScore,
  scopeKey,
  wrapMemory,
  type MemoryDraft,
  type MemoryEntry,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatus,
  type ProjectMemoryMode,
  type SourceRef
} from '../memory.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type {
  IndexDoc,
  MemoryIndex,
  MemoryPolicy,
  MemoryDistiller,
  MemoryMaintenanceJob,
  MemoryRetriever,
  MemorySecretFilter,
  MemorySettingsStore,
  MemorySource,
  MemoryStore
} from '../ports/memory.ts';
import type { Project } from '../project.ts';
import { err, ok, type Result } from '../result.ts';
import type { Session } from '../session.ts';
import { projectAsResource, type AccessPolicy } from './authorization.ts';
import type { Deps } from './deps.ts';

/**
 * 记忆服务（ADR 0019 · P1）：唯一入口。MCP 工具、HTTP 路由、界面都只调它；它只调端口。
 *
 * 谁在调：
 * - 会话（agent 经 MCP 工具）：身份 = 会话主人（和 agent-messaging 一样），能看的作用域由 hub 按会话算出来
 *   （本人 user、所在 project、本 session、所属 role），agent 只能用简写，不能指定任意 id；
 * - 人（界面 / 开放 API）：给完整的作用域键，逐个过 can()。
 */
export interface DistillSettings {
  readonly model: string | null;
  /** 项目开关（默认开）。 */
  readonly enabled: boolean;
  /** HUB_MEMORY_DISTILL=0：全站关了，项目设置不生效。 */
  readonly globalOff: boolean;
}

export type MemoryCaller = { readonly kind: 'session'; readonly sessionId: SessionId } | { readonly kind: 'user'; readonly principal: Principal };

export interface MemoryServiceDeps extends Pick<Deps, 'now' | 'sessions' | 'tasks' | 'projects'> {
  readonly store: MemoryStore;
  readonly index: MemoryIndex;
  readonly settings: MemorySettingsStore;
  readonly sources: readonly MemorySource[];
  readonly policy: MemoryPolicy;
  readonly retriever: MemoryRetriever;
  /** 写入路径的提炼器（规则版 / 以后的模型版），由注册表装配。 */
  readonly distiller: MemoryDistiller;
  /** 选提炼模型时核对：设置人有 provider.use、作用域对得上项目、模型在提供商里（由 hub 装配；没有 = 只能用规则版）。 */
  readonly checkDistillModel?: (principal: Principal, projectId: string, model: string) => Promise<Result<true, DomainError>>;
  /** sweep 依次跑的维护任务。 */
  readonly jobs: readonly MemoryMaintenanceJob[];
  readonly secretFilter: MemorySecretFilter;
  readonly audit: Pick<AuditLog, 'append'>;
  readonly access?: AccessPolicy;
  readonly principalOf: (userId: string) => Promise<Principal | null>;
  /** 会话的角色（agent-messaging 按角色派生的会话才有）。 */
  readonly roleOf?: (sessionId: SessionId) => Promise<string | null>;
  /** 来源多久重扫一次（毫秒）；搜之前按需扫。 */
  readonly sourceTtlMs?: number;
}

export interface WriteInput extends MemoryDraft {
  /** 会话：'user' | 'role' | 'project' | 'session'；人：完整作用域键。 */
  readonly scope: string;
}
export interface SearchInput {
  readonly query: string;
  readonly scopes?: readonly string[];
  readonly kinds?: readonly MemoryKind[];
  readonly include?: readonly ('entries' | 'sources')[];
  readonly limit?: number;
  /** 也给 proposed / superseded / 过期的（带状态标记）。 */
  readonly includeInactive?: boolean;
  /** 也给暂存的（staged，提炼出来还没转正的；排序打 0.6 折）。 */
  readonly includeStaged?: boolean;
}
export interface SearchResult {
  readonly id?: string;
  readonly ref?: SourceRef;
  readonly origin: 'entry' | 'source';
  readonly scope: string;
  readonly title: string;
  readonly snippet: string;
  readonly trust: 'trusted' | 'untrusted';
  readonly score: number;
  readonly status?: MemoryStatus;
  readonly stale?: boolean;
}

export interface MemoryService {
  write(caller: MemoryCaller, input: WriteInput, via?: 'tool' | 'ui'): Promise<Result<MemoryEntry, DomainError>>;
  search(caller: MemoryCaller, input: SearchInput): Promise<Result<SearchResult[], DomainError>>;
  get(caller: MemoryCaller, input: { id?: string; ref?: SourceRef; scope?: string; offset?: number }): Promise<Result<unknown, DomainError>>;
  list(caller: MemoryCaller, input: { scope: string; kinds?: readonly MemoryKind[]; status?: readonly MemoryStatus[]; limit?: number }): Promise<Result<MemoryEntry[], DomainError>>;
  forget(caller: MemoryCaller, id: string, reason: string): Promise<Result<MemoryEntry, DomainError>>;
  review(principal: Principal, id: string, approve: boolean, note?: string): Promise<Result<MemoryEntry, DomainError>>;
  purge(principal: Principal, id: string): Promise<Result<void, DomainError>>;
  export(principal: Principal, scope: string): Promise<Result<MemoryEntry[], DomainError>>;
  /** 这个人能看的作用域（界面左边那一栏）。 */
  scopesFor(principal: Principal): Promise<{ key: string; label: string; canWrite: boolean; canReview: boolean }[]>;
  /** 等审核的（界面「待审」）。 */
  pending(principal: Principal): Promise<MemoryEntry[]>;
  projectMode(principal: Principal, projectId: string): Promise<Result<ProjectMemoryMode, DomainError>>;
  setProjectMode(principal: Principal, projectId: string, mode: ProjectMemoryMode): Promise<Result<ProjectMemoryMode, DomainError>>;
  /** 项目设置 · 会后提炼（ADR 0024）：选哪个模型（null = 规则版）。 */
  distillSettings(principal: Principal, projectId: string): Promise<Result<DistillSettings, DomainError>>;
  setDistillModel(principal: Principal, projectId: string, model: string | null): Promise<Result<DistillSettings, DomainError>>;
  setDistillEnabled(principal: Principal, projectId: string, enabled: boolean): Promise<Result<DistillSettings, DomainError>>;
  /** 重扫一个项目的来源：增量更新索引，出处变了的条目标 stale，变两次转 invalidated。 */
  reindex(projectId: string, force?: boolean): Promise<{ indexed: number; removed: number; staled: number }>;
  /**
   * 运行时压缩完（P2）：摘要写进 session:（episodic，生效）；再按 §6.1 提炼——项目层 staged 一条、工作方式候选进确认队列。
   * 同一会话同一代（压缩序号）只跑一次；会话太短、项目当天超额、摘要含疑似密钥都跳过。返回写了几条。
   */
  ingestCompaction(sessionId: SessionId, input: { seq: number; summary: string; tokensBefore?: number }): Promise<{ written: number; skipped?: string }>;
  /** 后台整理（一天最多一次）：把读时算出来的过期（staged 30 天、validTo 到期）物化成 expired，并从索引里拿掉。 */
  sweep(): Promise<{ expired: number; spotChecked: number }>;
  /**
   * 冲突提示（§9）：同作用域里和这条相似的当前有效条目（FTS 前 5），不自动合并，交给写入者决定要不要 supersedes。
   */
  similar(caller: MemoryCaller, entryId: string): Promise<{ id: string; title: string }[]>;
  /** 导入（§11）：JSONL，每行一个条目；一律 untrusted + proposed（要审核），via import。返回写了几条和每行的问题。 */
  importEntries(principal: Principal, scope: string, jsonl: string): Promise<Result<{ imported: number; problems: { line: number; message: string }[] }, DomainError>>;
  /** 会话第一轮垫的静态引导：注入要审计（只记版本，不记内容）。 */
  guidanceInjected(sessionId: SessionId, version: number): Promise<void>;
}

const FALLBACK_CONTEXT: AccessContext = { hubTeamId: null, settings: { membersCanAddMachines: true } };
const SOURCE_TTL_MS = 60_000;
const SHORTHANDS = ['user', 'role', 'project', 'session'] as const;
type Shorthand = (typeof SHORTHANDS)[number];

interface Who {
  readonly principal: Principal;
  readonly author: 'human' | 'agent';
  readonly session: Session | null;
  readonly project: Project | null;
  readonly role: string | null;
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const ttl = deps.sourceTtlMs ?? SOURCE_TTL_MS;
  const scanned = new Map<string, number>();
  const scanning = new Map<string, Promise<unknown>>();

  const context = async (): Promise<AccessContext> => (deps.access ? deps.access.context() : FALLBACK_CONTEXT);

  const projectOfSession = async (session: Session): Promise<Project | null> => {
    const task = await deps.tasks.byId(session.taskId);
    if (!task) return null;
    const project = await deps.projects.byId(task.projectId);
    return project && project.deletedAt === null ? project : null;
  };

  const who = async (caller: MemoryCaller): Promise<Result<Who, DomainError>> => {
    if (caller.kind === 'user') return ok({ principal: caller.principal, author: 'human', session: null, project: null, role: null });
    const session = await deps.sessions.byId(caller.sessionId);
    if (!session) return err(notFound('会话不存在'));
    const project = await projectOfSession(session);
    if (!project) return err(notFound('会话所属项目不存在'));
    const owner = session.createdBy ?? project.createdBy;
    const principal = owner ? await deps.principalOf(owner) : null;
    if (!principal) return err(forbidden('会话主人不可用（停用或不存在）'));
    const role = deps.roleOf ? await deps.roleOf(session.id) : null;
    return ok({ principal, author: 'agent', session, project, role });
  };

  /** 会话用简写，hub 补全 id；人用完整键。 */
  const resolveScope = (me: Who, raw: string): Result<MemoryScope, DomainError> => {
    if (me.session && me.project) {
      if (!(SHORTHANDS as readonly string[]).includes(raw)) return err(invalid(`scope 只能是 ${SHORTHANDS.join(' / ')}（hub 按当前会话补全）`));
      switch (raw as Shorthand) {
        case 'user':
          return ok({ kind: 'user', userId: me.principal.user.id });
        case 'project':
          return ok({ kind: 'project', projectId: me.project.id });
        case 'session':
          return ok({ kind: 'session', sessionId: me.session.id });
        case 'role':
          if (!me.role) return err(invalid('这条会话没有角色（不是按角色派生的），不能用 role 作用域'));
          return ok({ kind: 'role', teamId: me.project.teamId ?? me.principal.user.teamId ?? 'hub', role: me.role });
      }
    }
    const scope = parseScopeKey(raw);
    return scope ? ok(scope) : err(invalid('作用域格式不对（user:<id> / role:<team>/<name> / project:<id> / session:<id>）'));
  };

  /**
   * 作用域 → can() 用的资源（条目继承作用域的权限，设计 §10）。
   * 关系（own 范围下谁算「自己的」）：project 看项目创建者 + 成员；user 只认本人；
   * role 读 = 同团队成员，写 = 这个角色自己的会话；session 读 = 同项目，写 = 这条会话自己。
   */
  const resourceOf = async (me: Who, scope: MemoryScope, permission: Permission, ctx: AccessContext): Promise<Result<Resource, DomainError>> => {
    const id = scopeKey(scope);
    switch (scope.kind) {
      case 'project': {
        const project = await deps.projects.byId(asProjectId(scope.projectId));
        if (!project || project.deletedAt !== null) return err(notFound('项目不存在'));
        // 会话跨项目只能读别的项目（还得那个人本来就能读）
        if (me.project && me.project.id !== project.id && permission !== 'memory.read') return err(forbidden('会话只能写自己所在项目的记忆'));
        return ok({ ...projectAsResource(project, ctx), kind: 'memory', id });
      }
      case 'user':
        return ok({ kind: 'memory', id, teamId: me.principal.user.teamId, personal: true, createdBy: scope.userId });
      case 'role': {
        const sameTeam = scope.teamId === (me.principal.user.teamId ?? 'hub');
        const related = permission === 'memory.read' ? sameTeam : me.session !== null && me.role === scope.role;
        return ok({ kind: 'memory', id, teamId: scope.teamId, createdBy: null, sharedWith: related ? [me.principal.user.id] : [] });
      }
      case 'session': {
        const session = await deps.sessions.byId(asSessionId(scope.sessionId));
        if (!session) return err(notFound('会话不存在'));
        const project = await projectOfSession(session);
        if (!project) return err(notFound('会话所属项目不存在'));
        const base = projectAsResource(project, ctx);
        if (permission === 'memory.read') return ok({ ...base, kind: 'memory', id });
        // 写 / 忘：只有这条会话自己（或团队范围的人）
        const self = me.session?.id === session.id;
        return ok({ kind: 'memory', id, teamId: base.teamId, createdBy: self ? me.principal.user.id : null, sharedWith: [] });
      }
      case 'group':
        return err(invalid('群作用域要等群聊上线（P1 还没有群）'));
    }
  };

  const allowed = async (me: Who, permission: Permission, scope: MemoryScope, extra?: Partial<Resource>): Promise<Result<void, DomainError>> => {
    const ctx = await context();
    const resource = await resourceOf(me, scope, permission, ctx);
    if (!resource.ok) return resource;
    const decision = decide(me.principal, permission, { ...resource.value, ...extra }, ctx);
    if (!decision.allow) return err(forbidden(DENY_MESSAGES[decision.reason]));
    return ok(undefined);
  };
  const can = async (me: Who, permission: Permission, scope: MemoryScope, extra?: Partial<Resource>): Promise<boolean> => (await allowed(me, permission, scope, extra)).ok;

  /** 会话默认能看的作用域。 */
  const visibleScopes = async (me: Who): Promise<MemoryScope[]> => {
    const candidates: MemoryScope[] = [{ kind: 'user', userId: me.principal.user.id }];
    if (me.project) candidates.push({ kind: 'project', projectId: me.project.id });
    if (me.session) candidates.push({ kind: 'session', sessionId: me.session.id });
    if (me.role && me.project) candidates.push({ kind: 'role', teamId: me.project.teamId ?? me.principal.user.teamId ?? 'hub', role: me.role });
    const out: MemoryScope[] = [];
    for (const scope of candidates) if (await can(me, 'memory.read', scope)) out.push(scope);
    return out;
  };

  const audit = async (me: Who, action: AuditAction, target: string, detail: string, teamId?: string | null) =>
    deps.audit.append({
      id: newId(),
      actorId: me.principal.user.id,
      actorEmail: me.principal.user.email,
      action,
      target,
      detail: (me.session ? `[会话 ${me.session.id}] ${detail}` : detail).slice(0, 500),
      at: deps.now(),
      teamId: teamId ?? me.principal.user.teamId
    });

  const indexDoc = (entry: MemoryEntry): IndexDoc => ({
    key: `entry:${entry.id}`,
    scopeKey: scopeKey(entry.scope),
    origin: 'entry',
    title: entry.title,
    text: `${entry.body}\n${entry.tags.join(' ')}`,
    kind: entry.kind,
    trust: entry.trust,
    updatedAt: entry.updatedAt,
    ref: null
  });

  const authorKind = (me: Who) => (me.session ? ({ kind: 'session', id: me.session.id, onBehalfOf: me.principal.user.id } as const) : ({ kind: 'user', id: me.principal.user.id } as const));

  /** 取代：旧条目转 superseded，记上被谁取代（只加关系，不改内容；只追加项目里也允许）。 */
  const applySupersedes = async (entry: MemoryEntry): Promise<void> => {
    for (const oldId of entry.supersedes) {
      const old = await deps.store.get(oldId);
      if (!old || old.status !== 'active') continue;
      await deps.store.update({ ...old, status: 'superseded', supersededBy: entry.id, updatedAt: deps.now(), version: old.version + 1 }, old.version);
    }
  };

  const ensureSources = async (projectId: string): Promise<void> => {
    const last = scanned.get(projectId) ?? 0;
    if (deps.now() - last < ttl) return;
    const running = scanning.get(projectId);
    if (running) {
      await running;
      return;
    }
    const job = service.reindex(projectId).catch(() => undefined);
    scanning.set(projectId, job);
    try {
      await job;
    } finally {
      scanning.delete(projectId);
    }
  };

  const entryView = (entry: MemoryEntry, now: number): MemoryEntry => {
    const status = effectiveStatus(entry, now);
    return status === entry.status ? entry : { ...entry, status };
  };

  /**
   * 印证（§9.1）：同作用域里有 14 天内的 staged 条目和新写的标题一样、而且不是同一个作者（同一条会话自己重复不算），
   * 那条就转 active（仍然 untrusted，没经过人）。
   */
  const corroborate = async (entry: MemoryEntry): Promise<void> => {
    const now = deps.now();
    const key = normalizeTitle(entry.title);
    const author = (e: MemoryEntry) => `${e.provenance.author.kind}:${e.provenance.author.id}`;
    const staged = await deps.store.list([entry.scope], { status: ['staged'], limit: 200 });
    for (const old of staged) {
      if (old.id === entry.id || author(old) === author(entry)) continue;
      if (now - old.createdAt > STAGED_CORROBORATE_MS || effectiveStatus(old, now) !== 'staged') continue;
      if (normalizeTitle(old.title) !== key) continue;
      const updated = await deps.store.update({ ...old, status: 'active', updatedAt: now, version: old.version + 1 }, old.version);
      if (!updated) continue;
      await deps.index.upsert([indexDoc(updated)]);
      await systemAudit('memory.write', scopeKey(old.scope), `${old.id} staged → active（被 ${entry.id} 印证）`);
    }
  };

  const systemAudit = (action: AuditAction, target: string, detail: string, teamId: string | null = null) =>
    deps.audit.append({ id: newId(), actorId: 'system' as never, actorEmail: '', action, target, detail: detail.slice(0, 500), at: deps.now(), teamId });

  /** 当天每个项目跑过几次提炼（进程内计数；重启从 0 算，偏宽松但有上面的「每代一次」兜底）。 */
  const distillRuns = new Map<string, { day: number; count: number }>();
  /** 已经处理过的压缩代（会话:序号），防同一代重复。 */
  const distilled = new Set<string>();

  const distillView = async (projectId: string): Promise<DistillSettings> => ({
    model: await deps.settings.distillModel(projectId),
    enabled: await deps.settings.distillEnabled(projectId),
    globalOff: process.env.HUB_MEMORY_DISTILL === '0'
  });

  const service: MemoryService = {
    async ingestCompaction(sessionId, input) {
      const generation = `${sessionId}:${input.seq}`;
      if (distilled.has(generation)) return { written: 0, skipped: '这一代已经提炼过' };
      distilled.add(generation);
      if (distilled.size > 5000) distilled.clear();
      const summary = input.summary.trim();
      if (summary === '') return { written: 0, skipped: '没有摘要' };
      const session = await deps.sessions.byId(sessionId);
      if (!session) return { written: 0, skipped: '会话不存在' };
      const project = await projectOfSession(session);
      if (!project) return { written: 0, skipped: '会话所属项目不存在' };
      const traceId = `compaction:${generation}`;
      const existing = await deps.store.list([{ kind: 'session', sessionId }], { limit: 200 });
      if (existing.some((entry) => entry.provenance.traceId === traceId)) return { written: 0, skipped: '这一代已经提炼过' };
      const now = deps.now();
      const author = { kind: 'system', id: 'compaction' } as const;
      const base = (scope: MemoryScope, status: MemoryStatus, draft: MemoryDraft, via: 'compaction' | 'distill'): MemoryEntry => {
        const validity = MEMORY_VALIDITY_MS[draft.kind];
        return {
          id: newId(),
          scope,
          kind: draft.kind,
          title: draft.title,
          body: draft.body,
          tags: [...(draft.tags ?? [])],
          status,
          supersedes: [],
          supersededBy: null,
          validFrom: now,
          validTo: validity === null ? null : now + validity,
          provenance: { author, sources: draft.sources ?? [], via, traceId },
          trust: 'untrusted',
          stale: false,
          sourceChanges: 0,
          createdAt: now,
          updatedAt: now,
          version: 1
        };
      };
      const distillInput = { summary, sessionId, seq: input.seq, projectId: project.id };
      // 会话层摘要始终走规则版（不调模型）：只是摘要原文 + 密钥过滤
      const own = distillSummary(summary, { sessionId, seq: input.seq });
      if (own.length === 0) return { written: 0, skipped: '摘要含疑似密钥或为空，不写' };
      const written: MemoryEntry[] = [];
      // 1) 压缩摘要本身进 session:（生效；只这条会话和同项目的人看得到）
      const sessionEntry = base({ kind: 'session', sessionId }, 'active', own[0]!.draft, 'compaction');
      await deps.store.put(sessionEntry);
      written.push(sessionEntry);
      // 2) 会后提炼：太短的会话不提炼；每个项目每天最多 50 次
      let skipped: string | undefined;
      const day = Math.floor(now / 86_400_000);
      const runs = distillRuns.get(project.id);
      const count = runs && runs.day === day ? runs.count : 0;
      if (process.env.HUB_MEMORY_DISTILL === '0') skipped = '提炼已关闭（HUB_MEMORY_DISTILL=0）';
      else if (!(await deps.settings.distillEnabled(project.id))) skipped = '项目已关闭提炼';
      else if (input.tokensBefore !== undefined && input.tokensBefore < DISTILL_LIMITS.minTokens) skipped = '会话太短，不提炼';
      else if (count >= DISTILL_LIMITS.runsPerProjectPerDay) skipped = '项目当天提炼次数到上限';
      else {
        distillRuns.set(project.id, { day, count: count + 1 });
        // 只有真要提炼时才调提炼器（模型版会花钱）；状态只认 staged / proposed，绝不直接生效
        const candidates = deps.distiller.id === 'rule' ? own : await deps.distiller.distill(distillInput);
        for (const candidate of candidates.slice(0, DISTILL_LIMITS.maxOutputs)) {
          if (candidate.status !== 'staged' && candidate.status !== 'proposed') continue;
          if (secretKind(`${candidate.draft.title}\n${candidate.draft.body}`)) continue;
          const entry = base({ kind: 'project', projectId: project.id }, candidate.status, candidate.draft, 'distill');
          await deps.store.put(entry);
          written.push(entry);
        }
      }
      await deps.index.upsert(written.map(indexDoc));
      await systemAudit(
        'memory.write',
        `session:${sessionId}`,
        `压缩摘要 → ${written.map((entry) => `${entry.id}(${scopeKey(entry.scope)} ${entry.status})`).join(', ')}${skipped ? `；${skipped}` : ''}`,
        project.teamId ?? null
      );
      return { written: written.length, ...(skipped ? { skipped } : {}) };
    },

    async sweep() {
      const ctx = { now: deps.now(), store: deps.store, index: deps.index, indexDoc };
      const counts = new Map<string, number>();
      for (const job of deps.jobs) {
        try {
          counts.set(job.id, (await job.run(ctx)).count);
        } catch {
          counts.set(job.id, 0);
        }
      }
      const expired = counts.get('expire') ?? 0;
      const spotChecked = counts.get('spot-check') ?? 0;
      const others = [...counts].filter(([id, n]) => id !== 'expire' && id !== 'spot-check' && n > 0);
      if (expired > 0 || spotChecked > 0 || others.length > 0)
        await systemAudit('memory.write', 'memory:sweep', `后台整理：${expired} 条过期，${spotChecked} 条抽查回待审${others.map(([id, n]) => `，${id} ${n} 条`).join('')}`);
      return { expired, spotChecked };
    },

    async similar(caller, entryId) {
      const me = await who(caller);
      if (!me.ok) return [];
      const entry = await deps.store.get(entryId);
      if (!entry || !(await can(me.value, 'memory.read', entry.scope))) return [];
            // 标题切成 3 字一段（OR）：CJK 没有空格，整句当一个词只能精确匹配
      const chars = [...entry.title.replace(/\s+/g, ' ')];
      const chunks: string[] = [];
      for (let at = 0; at + 3 <= chars.length && chunks.length < 12; at += 2) chunks.push(chars.slice(at, at + 3).join(''));
      const text = chunks.length > 0 ? chunks.join(' ') : entry.title;
      const hits = await deps.index.query({ text, scopeKeys: [scopeKey(entry.scope)], origins: ['entry'], limit: 10 }).catch(() => []);
      const now = deps.now();
      const out: { id: string; title: string }[] = [];
      for (const hit of hits) {
        const otherId = hit.key.startsWith('entry:') ? hit.key.slice(6) : null;
        if (!otherId || otherId === entry.id || entry.supersedes.includes(otherId)) continue;
        const other = await deps.store.get(otherId);
        if (!other || !isCurrent(other, now)) continue;
        out.push({ id: other.id, title: other.title });
        if (out.length >= 5) break;
      }
      return out;
    },

    async importEntries(principal, raw, jsonl) {
      const me: Who = { principal, author: 'human', session: null, project: null, role: null };
      const scope = resolveScope(me, raw);
      if (!scope.ok) return scope;
      const permitted = await allowed(me, 'memory.write', scope.value);
      if (!permitted.ok) return permitted;
      const lines = jsonl.split('\n');
      if (lines.length > 1000) return err(invalid('一次最多导入 1000 行'));
      const problems: { line: number; message: string }[] = [];
      let imported = 0;
      const now = deps.now();
      for (const [index, line] of lines.entries()) {
        if (line.trim() === '') continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          problems.push({ line: index + 1, message: '不是 JSON' });
          continue;
        }
        const draft: MemoryDraft = {
          kind: parsed.kind as MemoryKind,
          title: typeof parsed.title === 'string' ? parsed.title : '',
          body: typeof parsed.body === 'string' ? parsed.body : '',
          tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === 'string') : [],
          sources: Array.isArray((parsed.provenance as { sources?: unknown } | undefined)?.sources)
            ? ((parsed.provenance as { sources: SourceRef[] }).sources.filter((ref) => typeof ref?.source === 'string' && typeof ref?.uri === 'string'))
            : []
        };
        const problem = draftProblem(draft);
        if (problem) {
          problems.push({ line: index + 1, message: problem });
          continue;
        }
        if (deps.secretFilter.check(`${draft.title}\n${draft.body}`)) {
          problems.push({ line: index + 1, message: '看起来含有密钥，跳过' });
          continue;
        }
        const validity = MEMORY_VALIDITY_MS[draft.kind];
        const entry: MemoryEntry = {
          id: newId(),
          scope: scope.value,
          kind: draft.kind,
          title: draft.title.trim(),
          body: draft.body,
          tags: [...new Set((draft.tags ?? []).map((tag) => tag.trim()))],
          status: 'proposed',
          supersedes: [],
          supersededBy: null,
          validFrom: now,
          validTo: validity === null ? null : now + validity,
          provenance: { author: { kind: 'user', id: principal.user.id }, sources: draft.sources ?? [], via: 'import' },
          trust: 'untrusted',
          stale: false,
          sourceChanges: 0,
          createdAt: now,
          updatedAt: now,
          version: 1
        };
        await deps.store.put(entry);
        await deps.index.upsert([indexDoc(entry)]);
        imported += 1;
      }
      await audit(me, 'memory.write', scopeKey(scope.value), `导入 ${imported} 条（待审），${problems.length} 行有问题`);
      return ok({ imported, problems: problems.slice(0, 50) });
    },


    async write(caller, input, via = caller.kind === 'session' ? 'tool' : 'ui') {
      const me = await who(caller);
      if (!me.ok) return me;
      const scope = resolveScope(me.value, input.scope);
      if (!scope.ok) return scope;
      const problem = draftProblem(input);
      if (problem) return err(invalid(problem));
      const secret = deps.secretFilter.check(`${input.title}\n${input.body}\n${(input.sources ?? []).map((ref) => `${ref.uri} ${ref.quote ?? ''}`).join('\n')}`);
      if (secret) {
        await audit(me.value, 'memory.reject', scopeKey(scope.value), `疑似密钥（${secret}），拒绝写入`);
        return err(invalid(`看起来含有密钥（${secret}），不能写进记忆；记「去哪儿取」，不要记值`));
      }
      const permitted = await allowed(me.value, 'memory.write', scope.value);
      if (!permitted.ok) return permitted;
      for (const oldId of input.supersedes ?? []) {
        const old = await deps.store.get(oldId);
        if (!old || scopeKey(old.scope) !== scopeKey(scope.value)) return err(invalid(`要取代的 ${oldId} 不在这个作用域里`));
        if (!isCurrent(old, deps.now())) return err(conflict(`要取代的 ${oldId} 已经不是有效状态（${effectiveStatus(old, deps.now())}）`));
      }
      const projectMode = scope.value.kind === 'project' ? await deps.settings.projectMode(scope.value.projectId) : 'append-only';
      const own =
        (scope.value.kind === 'user' && scope.value.userId === me.value.principal.user.id) ||
        (scope.value.kind === 'session' && me.value.session?.id === scope.value.sessionId) ||
        (scope.value.kind === 'role' && me.value.role === scope.value.role);
      const canReview = me.value.author === 'human' && (await can(me.value, 'memory.review', scope.value));
      const decision = await deps.policy.onWrite({ scope: scope.value, kind: input.kind, title: input.title, body: input.body }, { author: me.value.author, own, canReview, projectMode });
      if (decision.action === 'reject') {
        await audit(me.value, 'memory.reject', scopeKey(scope.value), decision.reason ?? '策略拒绝');
        return err(invalid(decision.reason ?? '记忆策略拒绝了这条'));
      }
      const now = deps.now();
      const validity = MEMORY_VALIDITY_MS[input.kind];
      const entry: MemoryEntry = {
        id: newId(),
        scope: scope.value,
        kind: input.kind,
        title: input.title.trim(),
        body: input.body,
        tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()))],
        status: decision.action === 'accept' ? 'active' : 'proposed',
        supersedes: [...new Set(input.supersedes ?? [])],
        supersededBy: null,
        validFrom: now,
        validTo: validity === null ? null : now + validity,
        provenance: { author: authorKind(me.value), sources: input.sources ?? [], via },
        // 人写的可信；agent 写的不可信，审核通过才变可信
        trust: me.value.author === 'human' ? 'trusted' : 'untrusted',
        stale: false,
        sourceChanges: 0,
        createdAt: now,
        updatedAt: now,
        version: 1
      };
      await deps.store.put(entry);
      if (entry.status === 'active') await applySupersedes(entry);
      await corroborate(entry);
      await deps.index.upsert([indexDoc(entry)]);
      await audit(
        me.value,
        'memory.write',
        scopeKey(entry.scope),
        `${entry.id} ${entry.kind} → ${entry.status}${decision.reason ? `（${decision.reason}）` : ''}${entry.supersedes.length ? ` 取代 ${entry.supersedes.join(',')}` : ''}：${entry.title}`.slice(0, 300)
      );
      return ok(entry);
    },

    async search(caller, input) {
      const me = await who(caller);
      if (!me.ok) return me;
      if (input.query.trim() === '') return err(invalid('要给 query'));
      const limit = Math.min(Math.max(input.limit ?? 8, 1), MEMORY_SEARCH_LIMIT_MAX);
      let scopes: MemoryScope[];
      if (me.value.session) {
        const visible = await visibleScopes(me.value);
        // 调用方只能缩小
        if (input.scopes && input.scopes.length > 0) {
          const wanted: string[] = [];
          for (const raw of input.scopes) {
            const resolved = resolveScope(me.value, raw);
            if (!resolved.ok) return resolved;
            wanted.push(scopeKey(resolved.value));
          }
          scopes = visible.filter((scope) => wanted.includes(scopeKey(scope)));
        } else scopes = visible;
      } else {
        scopes = [];
        for (const raw of input.scopes ?? []) {
          const resolved = resolveScope(me.value, raw);
          if (!resolved.ok) return resolved;
          if (await can(me.value, 'memory.read', resolved.value)) scopes.push(resolved.value);
        }
        if ((input.scopes ?? []).length === 0) scopes = (await service.scopesFor(me.value.principal)).flatMap((s) => parseScopeKey(s.key) ?? []);
      }
      if (scopes.length === 0) return ok([]);
      for (const scope of scopes) if (scope.kind === 'project' && (input.include ?? ['entries', 'sources']).includes('sources')) await ensureSources(scope.projectId);
      const retriever = deps.retriever;
      const hits = await retriever.retrieve({ text: input.query, scopes, kinds: input.kinds, include: input.include, limit: limit * 2 });
      const now = deps.now();
      const results: SearchResult[] = [];
      for (const hit of hits) {
        if (hit.origin === 'entry') {
          const entry = hit.entryId ? await deps.store.get(hit.entryId) : null;
          if (!entry) continue;
          const status = effectiveStatus(entry, now);
          if (status === 'forgotten' || status === 'rejected') continue;
          if (status !== 'active' && !input.includeInactive && !(status === 'staged' && input.includeStaged)) continue;
          const score = rankScore(hit.score, entry.updatedAt, entry.trust, now, entry.stale) * (status === 'staged' ? 0.6 : 1);
          results.push({
            id: entry.id,
            origin: 'entry',
            scope: scopeKey(entry.scope),
            title: entry.title,
            snippet: wrapMemory(hit.snippet, entry.trust, `entry:${entry.id}`),
            trust: entry.trust,
            score,
            status,
            ...(entry.stale ? { stale: true } : {})
          });
        } else {
          const score = rankScore(hit.score, hit.updatedAt, hit.trust, now);
          results.push({
            ...(hit.ref ? { ref: { source: hit.ref.source, uri: hit.ref.uri } } : {}),
            origin: 'source',
            scope: hit.scopeKey,
            title: hit.title,
            snippet: wrapMemory(hit.snippet, hit.trust, hit.ref ? `${hit.ref.source}:${hit.ref.uri}` : hit.key),
            trust: hit.trust,
            score
          });
        }
      }
      return ok(results.sort((a, b) => b.score - a.score).slice(0, limit));
    },

    async get(caller, input) {
      const me = await who(caller);
      if (!me.ok) return me;
      const now = deps.now();
      if (input.id) {
        const entry = await deps.store.get(input.id);
        if (!entry) return err(notFound('没有这条记忆'));
        const permitted = await allowed(me.value, 'memory.read', entry.scope);
        if (!permitted.ok) return err(notFound('没有这条记忆'));
        const view = entryView(entry, now);
        return ok({
          ...view,
          scope: scopeKey(view.scope),
          body: wrapMemory(view.body, view.trust, `entry:${view.id}`),
          ...(view.stale ? { notice: '来源已变化：这条可能过时了，核对出处再用' } : {})
        });
      }
      if (!input.ref) return err(invalid('要给 id 或 ref'));
      const ref = input.ref;
      const source = deps.sources.find((candidate) => candidate.id === ref.source);
      if (!source) return err(notFound(`没有这个来源：${ref.source}`));
      // 来源一律挂在项目下：会话默认自己的项目，人要给 scope
      let scope: MemoryScope | null = null;
      if (input.scope) {
        const resolved = resolveScope(me.value, input.scope);
        if (!resolved.ok) return resolved;
        scope = resolved.value;
      } else if (me.value.project) scope = { kind: 'project', projectId: me.value.project.id };
      if (!scope) return err(invalid('读来源要给 scope（project:<id>）'));
      if (!source.scopeKinds.includes(scope.kind)) return err(invalid('这个来源不在这个作用域里'));
      const permitted = await allowed(me.value, 'memory.read', scope);
      if (!permitted.ok) return err(notFound('读不到这个来源'));
      const read = await source.read(scope, ref);
      if (!read) return err(notFound('来源里没有这一段了（可能被删了）'));
      const offset = Math.max(0, Math.floor(input.offset ?? 0));
      const chunk = read.text.slice(offset, offset + MEMORY_READ_CHUNK);
      const next = offset + chunk.length < read.text.length ? offset + chunk.length : null;
      return ok({
        ref: { source: ref.source, uri: ref.uri, hash: read.hash },
        scope: scopeKey(scope),
        text: wrapMemory(chunk, 'untrusted', `${ref.source}:${ref.uri}`),
        offset,
        nextOffset: next,
        total: read.text.length
      });
    },

    async list(caller, input) {
      const me = await who(caller);
      if (!me.ok) return me;
      const scope = resolveScope(me.value, input.scope);
      if (!scope.ok) return scope;
      const permitted = await allowed(me.value, 'memory.read', scope.value);
      if (!permitted.ok) return permitted;
      const now = deps.now();
      const entries = await deps.store.list([scope.value], { kinds: input.kinds, limit: Math.min(Math.max(input.limit ?? 50, 1), 200) });
      return ok(
        entries
          .map((entry) => entryView(entry, now))
          .filter((entry) => (input.status && input.status.length > 0 ? input.status.includes(entry.status) : entry.status !== 'forgotten'))
      );
    },

    async forget(caller, id, reason) {
      const me = await who(caller);
      if (!me.ok) return me;
      if (reason.trim() === '') return err(invalid('要写忘掉的原因'));
      const entry = await deps.store.get(id);
      if (!entry) return err(notFound('没有这条记忆'));
      if (!(await can(me.value, 'memory.read', entry.scope))) return err(notFound('没有这条记忆'));
      // 成员只能忘自己写的；owner / admin 范围是 team
      const writer = entry.provenance.author.kind === 'user' ? entry.provenance.author.id : (entry.provenance.author.onBehalfOf ?? null);
      const permitted = await allowed(me.value, 'memory.forget', entry.scope, { createdBy: writer, sharedWith: [] });
      if (!permitted.ok) return permitted;
      if (entry.status === 'forgotten') return ok(entry);
      const updated = await deps.store.update({ ...entry, status: 'forgotten', updatedAt: deps.now(), version: entry.version + 1 }, entry.version);
      if (!updated) return err(conflict('这条记忆刚被改过，刷新后再试'));
      await deps.index.remove([`entry:${entry.id}`]);
      await audit(me.value, 'memory.forget', scopeKey(entry.scope), `${entry.id}：${reason.slice(0, 200)}`);
      return ok(updated);
    },

    async review(principal, id, approve, note) {
      const me: Who = { principal, author: 'human', session: null, project: null, role: null };
      const entry = await deps.store.get(id);
      if (!entry) return err(notFound('没有这条记忆'));
      if (!(await can(me, 'memory.read', entry.scope))) return err(notFound('没有这条记忆'));
      // user 作用域：本人确认就算审核；其他走 memory.review
      const self = entry.scope.kind === 'user' && entry.scope.userId === principal.user.id;
      if (!self) {
        const permitted = await allowed(me, 'memory.review', entry.scope);
        if (!permitted.ok) return permitted;
      }
      const current = effectiveStatus(entry, deps.now());
      if (current !== 'proposed' && current !== 'staged') return err(conflict('这条不在待审 / 暂存状态'));
      const now = deps.now();
      const next: MemoryEntry = {
        ...entry,
        status: approve ? 'active' : 'rejected',
        trust: approve ? 'trusted' : entry.trust,
        provenance: { ...entry.provenance, reviewedBy: principal.user.id, reviewedAt: now },
        updatedAt: now,
        version: entry.version + 1
      };
      const updated = await deps.store.update(next, entry.version);
      if (!updated) return err(conflict('这条记忆刚被改过，刷新后再试'));
      if (approve) await applySupersedes(updated);
      if (approve) await deps.index.upsert([indexDoc(updated)]);
      else await deps.index.remove([`entry:${entry.id}`]);
      await audit(me, 'memory.review', scopeKey(entry.scope), `${entry.id} ${approve ? '通过' : '拒绝'}${note ? `：${note.slice(0, 200)}` : ''}`);
      return ok(updated);
    },

    async purge(principal, id) {
      const me: Who = { principal, author: 'human', session: null, project: null, role: null };
      const entry = await deps.store.get(id);
      if (!entry) return err(notFound('没有这条记忆'));
      const permitted = await allowed(me, 'memory.purge', entry.scope);
      if (!permitted.ok) return permitted;
      await deps.store.purge(id);
      await deps.index.remove([`entry:${id}`]);
      await audit(me, 'memory.purge', scopeKey(entry.scope), `${id} 彻底删除：${entry.title}`.slice(0, 300));
      return ok(undefined);
    },

    async export(principal, raw) {
      const me: Who = { principal, author: 'human', session: null, project: null, role: null };
      const scope = resolveScope(me, raw);
      if (!scope.ok) return scope;
      const permitted = await allowed(me, 'memory.export', scope.value);
      if (!permitted.ok) return permitted;
      const entries = await deps.store.list([scope.value], { limit: 10_000 });
      await audit(me, 'memory.export', scopeKey(scope.value), `${entries.length} 条`);
      return ok(entries);
    },

    async scopesFor(principal) {
      const me: Who = { principal, author: 'human', session: null, project: null, role: null };
      const out: { key: string; label: string; canWrite: boolean; canReview: boolean }[] = [];
      const add = async (scope: MemoryScope, label: string) => {
        if (!(await can(me, 'memory.read', scope))) return;
        out.push({ key: scopeKey(scope), label, canWrite: await can(me, 'memory.write', scope), canReview: await can(me, 'memory.review', scope) });
      };
      await add({ kind: 'user', userId: principal.user.id }, '我的');
      const projects = await deps.projects.list();
      for (const project of projects) if (project.deletedAt === null) await add({ kind: 'project', projectId: project.id }, `项目 · ${project.name}`);
      return out;
    },

    async pending(principal) {
      const scopes = (await service.scopesFor(principal)).filter((scope) => scope.canReview || scope.key === `user:${principal.user.id}`);
      const parsed = scopes.flatMap((scope) => parseScopeKey(scope.key) ?? []);
      if (parsed.length === 0) return [];
      const now = deps.now();
      return (await deps.store.list(parsed, { status: ['proposed', 'staged'], limit: 200 })).filter((entry) => {
        const status = effectiveStatus(entry, now);
        return status === 'proposed' || status === 'staged';
      });
    },

    async projectMode(principal, projectId) {
      const me: Who = { principal, author: 'human', session: null, project: null, role: null };
      const permitted = await allowed(me, 'memory.read', { kind: 'project', projectId });
      if (!permitted.ok) return permitted;
      return ok(await deps.settings.projectMode(projectId));
    },

    async setProjectMode(principal, projectId, mode) {
      if (mode !== 'append-only' && mode !== 'review') return err(invalid('模式只能是 append-only 或 review'));
      const me: Who = { principal, author: 'human', session: null, project: null, role: null };
      // 改写入策略和审核是一类事：要能审核这个项目的记忆
      const permitted = await allowed(me, 'memory.review', { kind: 'project', projectId });
      if (!permitted.ok) return permitted;
      const before = await deps.settings.projectMode(projectId);
      await deps.settings.setProjectMode(projectId, mode, deps.now());
      if (before !== mode) await audit(me, 'memory.settings', `project:${projectId}`, `写入模式 ${before} → ${mode}`);
      return ok(mode);
    },

    async distillSettings(principal, projectId) {
      const me: Who = { principal, author: 'human', session: null, project: null, role: null };
      const permitted = await allowed(me, 'memory.read', { kind: 'project', projectId });
      if (!permitted.ok) return permitted;
      return ok(await distillView(projectId));
    },

    async setDistillEnabled(principal, projectId, enabled) {
      const me: Who = { principal, author: 'human', session: null, project: null, role: null };
      const permitted = await allowed(me, 'memory.review', { kind: 'project', projectId });
      if (!permitted.ok) return permitted;
      const before = await deps.settings.distillEnabled(projectId);
      await deps.settings.setDistillEnabled(projectId, enabled, deps.now());
      if (before !== enabled) await audit(me, 'memory.settings', `project:${projectId}`, `会后提炼 ${before ? '开' : '关'} → ${enabled ? '开' : '关'}`);
      return ok(await distillView(projectId));
    },

    async setDistillModel(principal, projectId, model) {
      const me: Who = { principal, author: 'human', session: null, project: null, role: null };
      const permitted = await allowed(me, 'memory.review', { kind: 'project', projectId });
      if (!permitted.ok) return permitted;
      if (model !== null) {
        if (!deps.checkDistillModel) return err(invalid('这个 hub 没有装模型版提炼器'));
        const checked = await deps.checkDistillModel(principal, projectId, model);
        if (!checked.ok) return checked;
      }
      const before = await deps.settings.distillModel(projectId);
      await deps.settings.setDistillModel(projectId, model, deps.now());
      if (before !== model) await audit(me, 'memory.settings', `project:${projectId}`, `提炼模型 ${before ?? '规则版'} → ${model ?? '规则版'}`);
      return ok(await distillView(projectId));
    },

    async reindex(projectId, force = false) {
      const scope: MemoryScope = { kind: 'project', projectId };
      const key = scopeKey(scope);
      let indexed = 0;
      let removed = 0;
      let staled = 0;
      scanned.set(projectId, deps.now());
      for (const source of deps.sources) {
        if (!source.scopeKinds.includes('project')) continue;
        let changes;
        try {
          changes = await source.scan(scope);
        } catch {
          continue;
        }
        const before = await deps.index.indexed(key, source.id);
        const seen = new Set<string>();
        const upserts: IndexDoc[] = [];
        for (const doc of changes.docs) {
          const docKey = `src:${source.id}:${doc.ref.uri}`;
          seen.add(docKey);
          const previous = before.get(docKey);
          if (previous === doc.ref.hash && !force) continue;
          upserts.push({ key: docKey, scopeKey: key, origin: 'source', title: doc.title, text: doc.text, kind: null, trust: 'untrusted', updatedAt: doc.updatedAt, ref: doc.ref });
          // 出处变了：引用它的条目标 stale；累计变两次转 invalidated（不删，历史可查）
          if (previous !== undefined && previous !== doc.ref.hash) staled += await markCiting(source.id, doc.ref.uri, doc.ref.hash);
        }
        if (upserts.length > 0) await deps.index.upsert(upserts);
        indexed += upserts.length;
        if (!changes.partial) {
          const gone = [...before.keys()].filter((docKey) => !seen.has(docKey));
          if (gone.length > 0) {
            await deps.index.remove(gone);
            removed += gone.length;
            for (const docKey of gone) staled += await markCiting(source.id, docKey.slice(`src:${source.id}:`.length), null);
          }
        }
      }
      return { indexed, removed, staled };
    },

    async guidanceInjected(sessionId, version) {
      const me = await who({ kind: 'session', sessionId });
      if (!me.ok) return;
      await audit(me.value, 'memory.guidance', `session:${sessionId}`, `注入静态记忆引导 v${version}`, me.value.project?.teamId ?? null);
    }
  };

  async function markCiting(source: string, uri: string, hash: string | null): Promise<number> {
    let count = 0;
    for (const entry of await deps.store.citing(source, uri)) {
      const cited = entry.provenance.sources.find((ref) => ref.source === source && ref.uri === uri);
      if (cited?.hash !== undefined && cited.hash === hash) continue;
      if (entry.status === 'forgotten' || entry.status === 'rejected' || entry.status === 'invalidated') continue;
      const changes = entry.sourceChanges + 1;
      const status: MemoryStatus = changes >= SOURCE_CHANGES_INVALIDATE && entry.status === 'active' ? 'invalidated' : entry.status;
      const updated = await deps.store.update({ ...entry, stale: true, sourceChanges: changes, status, updatedAt: deps.now(), version: entry.version + 1 }, entry.version);
      if (updated) count += 1;
      if (updated && status === 'invalidated') await deps.index.remove([`entry:${entry.id}`]);
    }
    return count;
  }

  return service;
}

