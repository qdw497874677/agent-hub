import type { StrategyChoice } from '../context-strategy.ts';

/** 上下文策略的选择（ADR 0020 §8）。键：'hub' | 'project:<id>' | 'role:<projectId>:<role>' | 'session:<id>'。 */
export interface ContextSetting extends StrategyChoice {
  /** 只有项目层有：会话 / 角色能从哪些策略里选。 */
  readonly enabled?: readonly string[];
  readonly updatedAt: number;
  readonly updatedBy: string;
}

export interface ContextSettingsStore {
  get(key: string): Promise<ContextSetting | null>;
  set(key: string, value: ContextSetting | null): Promise<void>;
}
