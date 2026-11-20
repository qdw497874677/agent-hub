import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type {
  ApiTokenDeps,
  AssetReviewDeps,
  ComponentDeps,
  DeleteProjectDeps,
  Deps,
  GitWorkflowService,
  MessageBus,
  MessageStore,
  Principal,
  TeamRepository,
  WorkspaceFilesService
} from '@agent-hub/domain';
import type { ProviderWiringApi } from '../providers.ts';
import type { SessionActivityOptions } from '../session-activity.ts';
import type { StreamHub } from '../stream-hub.ts';
import type { routes } from './routes.ts';

export interface OpenApiOptions {
  readonly tokens: Pick<ApiTokenDeps, 'apiTokens' | 'users' | 'tokens' | 'now'> & Partial<Pick<ApiTokenDeps, 'projects'>>;
  /** 每个令牌每分钟最多多少次请求 / 多少次 prompt；e2e 调小来验 429。 */
  readonly rate?: { readonly general?: number; readonly prompt?: number; readonly streams?: number };
  /** 对外 MCP 写工具的幂等回放（E4b）；不给就只有只读工具（写工具默认仍按令牌权限暴露）。 */
  readonly replays?: import('@agent-hub/domain').McpReplayStore;
  /** hub 设置：外部接入页的写工具开关（mcpWrites）从这里读。 */
  readonly settings?: { get(): Promise<import('@agent-hub/domain').HubSettings>; save(next: import('@agent-hub/domain').HubSettings): Promise<void> };
  /** MCP 调用记录（mcp.call）写到这里。 */
  readonly audit?: Pick<import('@agent-hub/domain').AuditLog, 'append'>;
  /** 团队目录：读/写团队运行时默认模型要用。不给则这两条路由 503。 */
  readonly teams?: import('@agent-hub/domain').TeamRepository;
  /** 组件目录 / 安装（内置浏览器）：不给则 install_builtin_browser 返 501。 */
  readonly components?: ComponentDeps;
}

export interface V1Context {
  readonly deps: Deps;
  readonly hub: StreamHub;
  readonly activity?: SessionActivityOptions;
  readonly providers?: ProviderWiringApi;
  readonly projectDeletion?: Pick<DeleteProjectDeps, 'toolGrants' | 'audit'>;
  readonly waitOptions?: (sessionId: string) => Promise<void>;
  // 资产审核（ADR 0016）：令牌默认只能交新版本（assets:submit）；显式给 assets:publish 才能发布 / 分配。
  readonly assetReview?: AssetReviewDeps;
  // 组件安装（ADR 0021）：内置浏览器安装 / 进度查询；不给 = install_builtin_browser 501。
  readonly components?: ComponentDeps;
  readonly git?: GitWorkflowService;
  /** 开放 API 的两个只读工具（workspace_diff / workspace_read_file）走工作空间文件服务；不给 = 503。 */
  readonly files?: WorkspaceFilesService;
  /** 会话通信 P1d：外部 agent 经消息总线发 send / ask、收回复。不给 = 这几条路由 501。 */
  readonly messaging?: { readonly bus: MessageBus; readonly messages?: MessageStore };
}

export type Env = { Variables: { principal: Principal }; Bindings: Record<string | symbol, unknown> };

type RateLimiter = ReturnType<typeof import('../rate-limit.ts').createRateLimiter>;

/**
 * installOpenApi 的前导状态：鉴权、限流、审计与依赖都在 app.ts 里构造一次，
 * 各能力的 installX(app, rt) 只读它，不再各自复制前导逻辑。
 */
export interface V1Runtime extends V1Context {
  readonly options: OpenApiOptions;
  readonly now: () => number;
  readonly principal: (c: Context) => Principal;
  readonly viaNote: (actor: Principal) => string;
  readonly projectLimited: (actor: Principal) => boolean;
  readonly auditDefaultAgent: (
    actor: Principal,
    target: string,
    agent: { readonly runtime: string; readonly model: string } | null
  ) => Promise<void>;
  readonly teamDefaultsDeps: () => { readonly teams: TeamRepository; readonly agentDefaults: NonNullable<Deps['agentDefaults']> } | null;
  readonly general: RateLimiter;
  readonly prompts: RateLimiter;
  readonly maxStreams: number;
  readonly openStreams: Map<string, number>;
  readonly tooMany: (c: Context, retry: number, message: string) => Response;
  /** 工作流服务（F4）：不给 = git 相关路由 503。 */
  readonly needGit: () => GitWorkflowService | null;
  /** 长轮询（P1d）：events / session_message 共用同一份挂起计数（每令牌 maxStreams 条）。 */
  readonly waitUntil: (c: Context, seconds: number | undefined, done: () => Promise<boolean>) => Promise<Response | null>;
}

/** 处理函数只拿 Context；类型由路由表里的 schema 约束请求，响应由契约测试比对。 */
export const openapiOn =
  (app: OpenAPIHono<Env>) =>
  (r: (typeof routes)[keyof typeof routes], handler: (c: Context<Env>) => Promise<Response> | Response): void => {
    app.openapi(r as never, handler as never);
  };

export const valid = <T>(c: Context, target: 'json' | 'query'): T => (c.req as unknown as { valid(t: string): T }).valid(target);
