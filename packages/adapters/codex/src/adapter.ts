import type { RuntimeAdapter } from '@agent-hub/domain';
import { createCodexRuntime } from './codex-runtime.ts';
import { discoverCodexModels } from './discover-models.ts';
import { codexReadiness } from './readiness.ts';

/**
 * Codex 适配器：`codex app-server`（JSON-RPC over stdio）。
 * 每会话一个进程；模型清单问 `model/list`，问不到就用静态清单兜底。
 */
export function codexAdapter(): RuntimeAdapter {
  return {
    id: 'codex',
    async prepare(ctx) {
      const codex = ctx.command('codex', 'CODEX_COMMAND', 'codex');
      const catalog = await discoverCodexModels(codex.command);
      return [
        {
          runtime: createCodexRuntime({
            command: codex.command,
            models: catalog.models,
            defaultModel: catalog.defaultModel,
            defaultEffort: catalog.defaultEffort,
            onAgentSessionRef: ctx.onAgentSessionRef,
            onOptions: ctx.onOptions
          }),
          readiness: codexReadiness(codex.command, {
            env: ctx.env,
            home: ctx.home,
            models: catalog.models,
            defaultModel: catalog.defaultModel
          }),
          hint: codex.hint,
          summary:
            catalog.source === 'app-server'
              ? `Codex 认得 ${catalog.models.length} 个模型（默认 ${catalog.defaultModel}）`
              : 'Codex（模型清单用静态兜底）'
        }
      ];
    }
  };
}

export { createCodexRuntime };
