import { createAcpRuntime } from '@agent-hub/adapter-acp';
import type { AcpAgentConfig } from '@agent-hub/adapter-acp';
import type { AgentRuntime, RuntimeOption } from '@agent-hub/domain';
import { grokDescriptor, grokDescriptorFor } from './descriptor.ts';

/** `--no-auto-update`：worker 拉起的子进程不该顺手升级 grok 本体。 */
export const GROK_ARGS = ['--no-auto-update', 'agent', 'stdio'] as const;

/**
 * Grok Build 是一个 ACP agent，只多两条握手规则：
 * - 带了 XAI_API_KEY 且 agent 认 `xai.api_key` 时走无头认证，否则用 `grok login` 缓存的凭据；
 * - 会话开在 yolo 模式，工具调用不再逐个回问（平台本来也会自动放行）。
 */
export function grokAcpConfig(command = 'grok'): AcpAgentConfig {
  return {
    id: 'grok',
    label: 'Grok Build',
    command,
    args: GROK_ARGS,
    authenticate: (methods) =>
      process.env['XAI_API_KEY'] && methods.includes('xai.api_key')
        ? { methodId: 'xai.api_key', _meta: { headless: true } }
        : null,
    sessionMeta: { yoloMode: true }
  };
}

export interface GrokRuntimeOptions {
  readonly command?: string;
  /** 启动时从 grok 问到的模型清单；为空时用 descriptor 的保守默认值。 */
  readonly models?: readonly string[];
  readonly defaultModel?: string;
  readonly onAgentSessionRef?: (sessionId: string, agentSessionRef: string) => void;
  readonly onOptions?: (sessionId: string, options: readonly RuntimeOption[]) => void;
  readonly toolShim?: { readonly command: string; readonly args: readonly string[] };
}

export function createGrokRuntime(options: GrokRuntimeOptions = {}): AgentRuntime {
  const descriptor =
    options.models !== undefined ? grokDescriptorFor(options.models, options.defaultModel ?? '') : grokDescriptor;
  return createAcpRuntime(grokAcpConfig(options.command), {
    descriptor,
    ...(options.onAgentSessionRef ? { onAgentSessionRef: options.onAgentSessionRef } : {}),
    ...(options.onOptions ? { onOptions: options.onOptions } : {}),
    ...(options.toolShim ? { toolShim: options.toolShim } : {})
  });
}
