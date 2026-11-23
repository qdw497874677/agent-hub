import type {
  BotColorDto,
  BotRecordDto,
  BotTriggersDto,
  GroupDeliveryDto,
  GroupDto,
  GroupInputDto,
  GroupPostDto,
  GroupReactionDto,
  GroupThreadDto,
  GroupUnreadDto,
  GroupViewDto,
  MessagingRoleDto
} from '@agent-hub/contract';
import { RequestFailed, call, post } from './http.ts';

export type {
  BotColorDto,
  BotRecordDto,
  BotTriggerDto,
  BotTriggerSourceDto,
  BotTriggersDto,
  GroupAuthorDto,
  GroupDeliveryDto,
  GroupDto,
  GroupInputDto,
  GroupLimitsDto,
  GroupPostDto,
  GroupReactionDto,
  GroupThreadDto,
  GroupUnreadDto,
  GroupViewDto,
  MessagingRoleDto
} from '@agent-hub/contract';

/** agent 间通信（ADR 0018）里的一条消息。 */
export type AgentMessagePartDto =
  | { readonly type: 'data'; readonly schema?: string; readonly data: unknown }
  | { readonly type: 'ref'; readonly repo: string; readonly branch?: string; readonly sha?: string }
  | { readonly type: 'file'; readonly session: string; readonly member?: string; readonly path: string }
  | { readonly type: 'link'; readonly url: string; readonly label?: string };

/** 会话通信 P1a：同伴（连了线、派生关系，或同一棵任务树里的会话）。 */
export interface SessionPeerDto {
  readonly address: string;
  readonly handle?: string;
  readonly label: string;
  readonly status: string;
  /** 只表示真的有显式连线（画布 / 连线选择器连的）；派生和同任务树不算。 */
  readonly connected?: boolean;
  /**
   * 为什么能互相发消息：显式连线 > 派生父子 > 同一棵顶层任务树。
   * 只解释已经存在的可达性；老服务端可能不给（这时别替它猜）。
   */
  readonly relation?: 'explicit' | 'task_tree' | 'spawn';
  readonly workerId?: string | null;
  readonly repo?: string | null;
  readonly branch?: string | null;
  readonly title?: string | null;
  readonly unread?: number;
}

export interface AgentMessageDto {
  readonly messageId: string;
  readonly traceId: string;
  readonly kind: 'send' | 'ask' | 'reply';
  readonly from: string;
  readonly to: string;
  readonly targetSessionId: string | null;
  readonly status: 'queued' | 'awaiting_approval' | 'held' | 'delivered' | 'answered' | 'done' | 'failed' | 'denied';
  readonly depth: number;
  /** 会话通信 P1a/P1d：外部发送者的署名、结构化附件、是否唤醒、回复状态、已读、被拦下的原因。 */
  readonly fromLabel?: string | null;
  readonly parts?: readonly AgentMessagePartDto[];
  readonly wake?: boolean;
  readonly replyStatus?: 'ok' | 'failed' | 'refused' | null;
  readonly replyParts?: readonly AgentMessagePartDto[];
  readonly readAt?: number | null;
  readonly holdReason?: 'pingpong' | 'privilege' | null;
  readonly replyTo: string | null;
  readonly body: string;
  readonly reply: string | null;
  readonly replySource: 'tool' | 'last_turn' | null;
  readonly failure: string | null;
  readonly failureDetail: string | null;
  readonly createdAt: number;
}

/** 一等 bot（C3c）：`/api/bots` 的增删改查；id 是稳定键，@id（name）建好不改。 */
export interface BotCreateInputDto {
  projectId: string;
  /** 就是 @id：小写字母、数字、- _；建好不改。 */
  name: string;
  agentId: string;
  model?: string;
  options?: Record<string, string | boolean>;
  displayName?: string;
  color?: BotColorDto;
  description?: string;
  reuse?: MessagingRoleDto['reuse'];
}
export type BotPatchInputDto = Omit<BotCreateInputDto, 'projectId' | 'name'>;

/**
 * 一个 bot 身上挂的触发器（`GET /api/bots/:idOrName/triggers`，只读汇总，形状见 contract）。
 * 后端还没这条路由时页面不能红：404 / 501 当成「没有触发器」，返回空表（每次新对象，别共享数组）。
 */
const emptyTriggers = (): BotTriggersDto => ({ sources: [], bindings: [] });

/**
 * 一条「bot 在某个项目里被授权」的记录（`GET /api/bots/:id/grants`）。
 * bot 归团队，项目只是授权；`workspaceId` 为 null 表示跟随项目默认工作目录。
 */
export interface BotGrantDto {
  readonly botId: string;
  readonly projectId: string;
  readonly workspaceId: string | null;
  readonly createdAt: number;
  readonly createdBy: string | null;
}

export const botsApi = {
  /** 只要「已授权到该项目」的 bot（授权撤销后不再出现）。 */
  list: (projectId: string) => call<{ bots: BotRecordDto[] }>(`/api/bots?projectId=${encodeURIComponent(projectId)}`),
  /** 团队里的全部 bot（不管授权），给「授权已有 bot」用。 */
  team: (teamId: string) => call<{ bots: BotRecordDto[] }>(`/api/bots/team/${encodeURIComponent(teamId)}`),
  grants: (botId: string) => call<{ grants: BotGrantDto[] }>(`/api/bots/${encodeURIComponent(botId)}/grants`),
  /** 授权（重复 PUT 幂等）；不传 workspaceId 就是跟随项目默认工作目录。 */
  grant: (botId: string, projectId: string, workspaceId?: string) =>
    call<{ ok: true; grant: BotGrantDto }>(
      `/api/bots/${encodeURIComponent(botId)}/grants/${encodeURIComponent(projectId)}`,
      { method: 'PUT', body: JSON.stringify(workspaceId ? { workspaceId } : {}) }
    ),
  revoke: (botId: string, projectId: string) =>
    call<{ ok: true }>(`/api/bots/${encodeURIComponent(botId)}/grants/${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
  create: (input: BotCreateInputDto) => post<BotRecordDto>('/api/bots', input),
  /** 只读：挂在它身上的连接器触发器；接口不在（404/501）时返回空表。 */
  triggers: async (id: string): Promise<BotTriggersDto> => {
    try {
      return await call<BotTriggersDto>(`/api/bots/${encodeURIComponent(id)}/triggers`);
    } catch (error) {
      if (error instanceof RequestFailed && (error.status === 404 || error.status === 501)) return emptyTriggers();
      throw error;
    }
  },
  /** PATCH 不接受 name（建好不改），只传要改的字段；传 {} 的 options 表示清空启动选项。 */
  update: (id: string, input: BotPatchInputDto) =>
    call<BotRecordDto>(`/api/bots/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  remove: (id: string) => call<{ ok: true }>(`/api/bots/${encodeURIComponent(id)}`, { method: 'DELETE' })
};

/** 群聊（ADR 0018 · 群组）。 */
export const groupApi = {
  list: (projectId: string) => call<{ groups: GroupDto[] }>(`/api/projects/${encodeURIComponent(projectId)}/groups`),
  create: (projectId: string, input: GroupInputDto) => post<GroupDto>(`/api/projects/${encodeURIComponent(projectId)}/groups`, input),
  view: (id: string) => call<GroupViewDto>(`/api/groups/${encodeURIComponent(id)}`),
  update: (id: string, input: GroupInputDto) => call<GroupDto>(`/api/groups/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) }),
  posts: (id: string) => call<{ posts: GroupPostDto[] }>(`/api/groups/${encodeURIComponent(id)}/posts?limit=200`),
  post: (id: string, body: string) => post<unknown>(`/api/groups/${encodeURIComponent(id)}/posts`, { body }),
  stop: (id: string) => post<unknown>(`/api/groups/${encodeURIComponent(id)}/stop`, {}),
  /** 表情反应：PUT 加、DELETE 撤；两种情况都回这条帖子最新的聚合值（以服务端为准）。 */
  react: (id: string, postId: string, emoji: string) =>
    post<{ reactions: GroupReactionDto[] }>(`/api/groups/${encodeURIComponent(id)}/posts/${encodeURIComponent(postId)}/reactions`, { emoji }),
  unreact: (id: string, postId: string, emoji: string) =>
    call<{ reactions: GroupReactionDto[] }>(
      `/api/groups/${encodeURIComponent(id)}/posts/${encodeURIComponent(postId)}/reactions?emoji=${encodeURIComponent(emoji)}`,
      { method: 'DELETE' }
    ),
  addMember: (id: string, role: string) => post<GroupDto>(`/api/groups/${encodeURIComponent(id)}/members`, { role }),
  addMembers: (id: string, roles: string[]) => post<GroupDto>(`/api/groups/${encodeURIComponent(id)}/members`, { roles }),
  removeMember: (id: string, role: string) => call<GroupDto>(`/api/groups/${encodeURIComponent(id)}/members/${encodeURIComponent(role)}`, { method: 'DELETE' }),
  chains: (id: string) => call<{ chains: { thread: GroupThreadDto; deliveries: GroupDeliveryDto[] }[] }>(`/api/groups/${encodeURIComponent(id)}/chains`),
  unread: () => call<GroupUnreadDto>('/api/groups/unread'),
  markRead: (id: string, seq?: number) => post<{ seq: number }>(`/api/groups/${encodeURIComponent(id)}/read`, seq === undefined ? {} : { seq }),
  roles: (projectId: string) => call<{ roles: MessagingRoleDto[]; limits: Record<string, number> }>(`/api/projects/${encodeURIComponent(projectId)}/messaging`)
};
