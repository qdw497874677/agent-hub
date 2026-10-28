import type { Seq, SessionId, TaskId } from '../ids.ts';
import type { SessionEvent } from '../event.ts';
import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';
import type { AgentDescriptor } from '../agent.ts';
import type { RuntimeOption } from '../option.ts';
import type { PromptInput } from '../attachment.ts';
import type { ToolAccess } from '../tool.ts';
import type { McpLaunch } from '../mcp.ts';

export interface StartSpec {
  readonly sessionId: SessionId;
  readonly taskId: TaskId;
  readonly workspaceRoot: string;
  /** 双权威：知道 agent 自己的会话 id 和平台已确认的游标，才能接着聊。 */
  readonly resume: { readonly agentSessionRef: string | null; readonly cursor: Seq } | null;
  /** 开跑前就要定下的可调项（键是 option id）。空对象 = 全部用 agent 的默认。 */
  readonly options: Readonly<Record<string, string | boolean>>;
  /** hub 能力层（MCP）。运行时按自己的方式注入：ACP 走 session/new.mcpServers，Pi 走环境变量。 */
  readonly tools?: ToolAccess;
  /** hub 下发到这台 Worker 的技能与指令（专属目录里的绝对路径）。运行时按自己的启动参数指过去，不碰全局目录。 */
  readonly assets?: SessionAssets;
  /**
   * hub 下发的 MCP 资产（只在有 tools 时给）。stdio 的 env 里是已展开的密钥：只许进 agent 拉起的那个进程，不许落盘、不许进日志；
   * http 的 url 是 Worker 本机中转入口（凭 tools.token 访问，hub 代连远端）。
   */
  readonly mcp?: readonly McpLaunch[];
}

/** Worker 专属资产目录里此刻装着的东西。 */
export interface SessionAssets {
  readonly root: string;
  /** path 是各技能 SKILL.md 的绝对路径（只含这次会话生效的）。 */
  readonly skills: readonly { readonly name: string; readonly description: string; readonly path: string }[];
  /** path 是 markdown 文件的绝对路径。 */
  readonly instructions: readonly { readonly name: string; readonly path: string }[];
}

export interface RuntimeSession {
  readonly sessionId: SessionId;
  /** 文本 + 附件。附件不认识的 agent 要返回带原因的错误，不许静默丢掉。 */
  prompt(input: PromptInput): Promise<Result<void, DomainError>>;
  interrupt(): Promise<void>;
  events(): AsyncIterable<SessionEvent>;
  adopt(cursor: Seq): Promise<void>;
  /** agent 报上来的可调项（含当前值）。agent 不给就返回空数组，界面就不显示选择器。 */
  options(): readonly RuntimeOption[];
  /** 改一项，返回**改完之后的全量清单**——换模型会连带改变别的项的可选值。 */
  changeOption(id: string, value: string | boolean): Promise<Result<readonly RuntimeOption[], DomainError>>;
  dispose(): Promise<void>;
}

/** 新增一个 agent = 实现这一个端口 + 填一张能力矩阵。 */
export interface AgentRuntime {
  readonly descriptor: AgentDescriptor;
  start(spec: StartSpec): Promise<Result<RuntimeSession, DomainError>>;
}
