import type { StrategyChoice } from '../context-strategy.ts';

/**
 * 上下文策略的选择（ADR 0020 §8）。键：'hub' | 'project:<id>' | 'bot:<projectId>:<name>' | 'session:<id>'。
 * 旧库的 'role:<projectId>:<name>' 仍然读（C3b 双读），写只用 'bot:'。
 */
export interface ContextSetting extends StrategyChoice {
  /** 只有项目层有：会话 / 角色能从哪些策略里选。 */
  readonly enabled?: readonly string[];
  readonly updatedAt: number;
  readonly updatedBy: string;
}

export interface ContextSettingsStore {
  get(key: string): Promise<ContextSetting | null>;
  set(key: string, value: ContextSetting | null): Promise<void>;
  /** 按键前缀列出（比如 'bot:<projectId>:'）。 */
  list(prefix: string): Promise<{ key: string; setting: ContextSetting }[]>;
}
