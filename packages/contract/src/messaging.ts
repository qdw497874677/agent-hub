/**
 * IM / 会话运行态视图契约（群聊、bot、投递、待办、连接器、上下文策略）。
 *
 * 目前只放类型，不做运行时校验：这些 DTO 原本手写在 `apps/web/src/shell/api.ts`，
 * 现在原样上提到契约，web 只从这里取类型。
 */

// ---- 群聊（ADR 0018 · 群组） ----

export interface GroupLimitsDto { maxRounds: number; maxMessages: number }
export interface GroupDto {
  id: string; projectId: string; name: string; members: string[]; hostRole: string | null;
  speakingStrategy: 'host' | 'volunteer'; limits: Partial<GroupLimitsDto>; held: string[]; needsUser: boolean;
  createdBy: string; createdAt: number; updatedAt: number;
}
export type GroupAuthorDto = { kind: 'user'; id: string; name: string } | { kind: 'agent'; role: string; sessionId: string } | { kind: 'system' };
export interface GroupPostDto { id: string; seq: number; threadId: string | null; round: number; author: GroupAuthorDto; body: string; mentions: string[]; needsUser: boolean; createdAt: number }
export interface GroupThreadDto { id: string; status: string; round: number; messages: number; createdAt: number; updatedAt: number }
export interface GroupDeliveryDto { id: string; round: number; purpose: 'host' | 'member' | 'bid'; role: string; sessionId: string | null; status: string; result: string | null; score: number | null; note?: string | null; promptChars: number; createdAt?: number }
export interface GroupViewDto { group: GroupDto; sessions: { role: string; sessionId: string; status: string }[]; running: GroupThreadDto[]; canManage: boolean }
export interface GroupInputDto { name: string; members: string[]; hostRole: string | null; speakingStrategy: 'host' | 'volunteer'; limits: Partial<GroupLimitsDto> }
export interface GroupUnreadDto {
  total: number;
  groups: { groupId: string; projectId: string; count: number }[];
}

// ---- 持久智能体（界面上叫 bot；name 就是 @id，建好不改） ----

export type BotColorDto = 'amber' | 'sage' | 'sky' | 'rose' | 'olive' | 'slate';
export interface MessagingRoleDto {
  name: string; displayName?: string; color?: BotColorDto; description: string; agentId: string; model: string; reuse: 'sticky' | 'per-trace' | 'always-new';
  /** 建会话时垫进去的启动选项（会话内仍可覆盖）；键与会话的可调项同源。 */
  options?: Record<string, string | boolean>;
}
export interface BotDto extends MessagingRoleDto {
  groups: { id: string; name: string; host: boolean }[];
  /** 这个 bot 的独立凭据（C1）：没有就是 null。 */
  token: { id: string; prefix: string; createdAt: number; lastUsedAt: number | null } | null;
}
export type BotInputDto = Partial<Omit<MessagingRoleDto, 'name'>>;

/**
 * 一等 bot（C3a）：项目里的常驻成员，`/api/bots` 的返回形状。
 * ref 拍平成 agentId / model / options，与 `MessagingRoleDto` 一致；另带 id、projectId 和时间戳。
 *
 * 注意与上面的 `BotDto` 区分：那个是「项目 bot 列表 + 群 / 凭据」的视图，web 在用；
 * 这里是一条 bot 记录本身。
 */
export interface BotRecordDto {
  id: string; projectId: string; name: string; agentId: string; model: string;
  options?: Record<string, string | boolean>;
  displayName?: string; color?: BotColorDto; description: string; reuse: 'sticky' | 'per-trace' | 'always-new';
  createdAt: number; updatedAt: number;
}

// ---- 传递 / 送达（ADR 0031 D2） ----

export interface DeliveryDto {
  id: string; sessionId: string; seq: number; kind: 'prompt';
  state: 'queued' | 'sending' | 'delivered' | 'undelivered' | 'cancelled';
  attempt: number; nextAt: number | null; lastError: string | null; createdAt: number; updatedAt: number;
}

// ---- 「等我处理」（ADR 0031 D1） ----

export type AttentionPhase = 'needs_approval' | 'needs_answer' | 'needs_review' | 'failed' | 'undelivered';
export interface AttentionItemDto {
  readonly sessionId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly agentId: string;
  readonly phase: AttentionPhase;
  readonly since: number;
  readonly reason: string;
  readonly possible: boolean;
  readonly expiresAt: number | null;
}
export interface AttentionDto {
  readonly items: readonly AttentionItemDto[];
  readonly working: number;
}

// ---- 连接器（ADR 0032）：bot 的触发、运行记录、关联项目、等我处理 ----

export interface TriggerRunDto { id: string; bindingId: string; externalId: string; plannedAt: number | null; catchup: boolean; state: 'waiting' | 'delivered' | 'done' | 'failed' | 'timeout' | 'skipped'; reason: string | null; sessionId: string | null; createdAt: number; updatedAt: number }
export interface BindingDto {
  id: string; connector: string; kind: string; agentProjectId: string; agentName: string; projectId: string | null; name: string; target: 'main' | 'new';
  params: Record<string, unknown>; enabled: boolean; pausedReason: string | null; consecutiveFailures: number; nextRunAt: number | null; mainSessionId: string | null;
  timeZone: string; summary: string; lastRun: TriggerRunDto | null; createdAt: number
}
export interface ConnectorNoticeDto { kind: 'binding_paused' | 'inbound_quarantined' | 'task_pending'; id: string; title: string; reason: string; since: number; projectId: string; agentName: string | null }

// ---- 上下文策略（ADR 0020 · P1） ----

export type L1LevelDto = 'runtime' | 'estimated' | 'missing';
export interface SessionContextDto {
  strategy: { id: string; version: string; title: string; modes: string[] };
  mode: 'hub-managed' | 'native' | 'runtime-plugin';
  source: 'session' | 'role' | 'project' | 'hub' | 'default';
  fallback: { wanted: string; reason: string } | null;
  sessionChoice: string | null;
  role: string | null;
  enabled: string[];
  capability: { runtime: string; modes: string[]; l1: Record<'usage' | 'compactionEvents' | 'transcript' | 'compact' | 'restart' | 'memoryTools', L1LevelDto>; gaps: string[] };
  usage: {
    usedTokens: number;
    windowTokens: number;
    estimated: boolean;
    usedRatio: number;
    level: 'ok' | 'soft' | 'hard';
    lastCompaction: { seq: number; ok: boolean; tokensBefore: number | null; tokensAfter: number | null } | null;
  };
}
export interface ProjectContextDto {
  strategy: string;
  enabled: string[];
  inherited: boolean;
  installed: { id: string; version: string; title: string; modes: string[] }[];
  candidates: { id: string; title: string; note: string }[];
  roles: { role: string; strategy: string }[];
}
