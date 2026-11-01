import { acpAdapter } from '@agent-hub/adapter-acp';
import { grokAdapter } from '@agent-hub/adapter-grok';
import { hermesAdapter } from '@agent-hub/adapter-hermes';
import { piAdapter } from '@agent-hub/adapter-pi';
import type { RuntimeAdapter } from '@agent-hub/domain';

/**
 * 运行时注册表：新增一个 agent = 实现一个 RuntimeAdapter，在这里加一行。
 * 顺序就是界面里 agent 的顺序。
 */
export const RUNTIME_ADAPTERS: readonly RuntimeAdapter[] = [piAdapter(), acpAdapter(), grokAdapter(), hermesAdapter()];
