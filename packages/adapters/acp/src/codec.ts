import type { AgentDescriptor, RuntimeOption, SessionEvent } from '@agent-hub/domain';
import type { AcpAgentConfig } from './config.ts';

/** 一条 `session/update` 的原始形状；ACP 扩展字段靠 codec 自己读。 */
export type AcpUpdate = Record<string, unknown>;

export interface AcpCodecContext {
  readonly update: AcpUpdate;
  /** `session/update` 的 `params._meta`；标准 ACP 没有，vendor 扩展放这里。 */
  readonly meta: unknown;
  /** 本会话已见过的工具 id → 展示名。codec 可以读，不要替换。 */
  readonly toolNames: Map<string, string>;
}

export interface AcpCodecResult {
  /** codec 已经翻译好的 Hub 事件；返回后不再走通用 mapper。 */
  readonly events: readonly SessionEvent[];
}

/**
 * 一个 runtime 的 ACP 私有语义 codec。
 *
 * - 内置代码，不是 `ACP_AGENTS` 配置；远程配置不能注入 codec。
 * - `session()` 每个 ACP 会话创建一份，可持有子代理等状态。
 * - 标准 ACP 不要在这里重写；`decode` 返回 null 就会回退通用 mapper。
 */
export interface AcpRuntimeCodec {
  readonly id: string;
  session(): AcpSessionCodec;
  /** 可选：在 acpDescriptor 之后修正能力/模型/默认值。 */
  descriptor?(descriptor: AgentDescriptor, config: AcpAgentConfig): AgentDescriptor;
  /** 可选：在 mapAcpOptions 之后修正语义；静态映射继续用 optionOverrides。 */
  options?(options: readonly RuntimeOption[], config: AcpAgentConfig): readonly RuntimeOption[];
}

export interface AcpSessionCodec {
  /**
   * 能处理就返回事件；返回 null 表示交给通用 mapper。
   * 抛错由 AcpSession 捕获并降级，不允许 codec 打断会话。
   */
  decode(context: AcpCodecContext): AcpCodecResult | null;
  /** 本轮结束/进程退出时收尾，例如给所有 running 子代理发 end。 */
  finish(status: 'completed' | 'failed' | 'cancelled'): readonly SessionEvent[];
}
