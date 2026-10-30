import type { AgentRuntime } from './agent-runtime.ts';
import type { HarnessReadiness } from './harness-readiness.ts';
import type { HarnessInstaller } from './harness-installer.ts';
import type { RuntimeOption } from '../option.ts';

/**
 * 统一运行时适配器契约（docs/design/runtime-adapter-contract.md，ADR 0013 D8）。
 *
 * 新增一个 agent = 实现这一个模块：它自己解析命令、问模型、给出 runtime + 就绪探测 + （可选）安装器。
 * Worker 的组合根只遍历注册表，不再认得任何具体 agent 的名字。
 */
export interface ToolShimCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** 解析出来的 harness 命令：hint 不为 null 表示机器上没有，就绪探测要带上这句怎么修。 */
export interface ResolvedCommand {
  readonly command: string;
  readonly hint: string | null;
}

export interface RuntimeAdapterContext {
  /** Worker 进程环境（只读视角；PATH 补全由 command() 负责）。 */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 用户家目录：读本机 agent 配置（只读）时从这里找，测试里换成临时目录。 */
  readonly home: string;
  readonly toolShim: ToolShimCommand;
  /** 按 X_COMMAND → PATH → 常见安装位置 → hub 管理的 shim 解析命令。 */
  command(name: string, envVar: string, agentId?: string): ResolvedCommand;
  log(message: string): void;
  onAgentSessionRef(sessionId: string, ref: string): void;
  onOptions(sessionId: string, options: readonly RuntimeOption[]): void;
}

/** 一个 agent 在这台机器上的全部组件。 */
export interface PreparedRuntime {
  readonly runtime: AgentRuntime;
  readonly readiness: HarnessReadiness;
  /** 命令缺失时的修复提示（Worker 用它包装就绪探测）。 */
  readonly hint: string | null;
  /** hub 知道怎么在线安装的才有。 */
  readonly installer?: HarnessInstaller;
  /** 启动日志里的一句话（例如「Pi 认得 12 个模型」）。 */
  readonly summary: string;
}

export interface RuntimeAdapter {
  /** 注册表里的唯一键（一个适配器可以产出多个 agent，例如 ACP_AGENTS）。 */
  readonly id: string;
  prepare(ctx: RuntimeAdapterContext): Promise<readonly PreparedRuntime[]>;
}
