import type { RuntimeAdapter } from '@agent-hub/domain';
import { createGrokRuntime } from './grok-runtime.ts';
import { discoverGrokModels } from './discover-models.ts';
import { grokReadiness } from './readiness.ts';
import { grokInstaller } from './installer.ts';
import { defaultGrokHomes } from './grok-provider.ts';

export function grokAdapter(): RuntimeAdapter {
  return {
    id: 'grok',
    async prepare(ctx) {
      const grok = ctx.command('grok', 'GROK_COMMAND');
      // 没装 grok 时返回空目录，Grok 用自己的默认模型；真正启动会话时再报不可用。
      const catalog = await discoverGrokModels(grok.command);
      return [
        {
          runtime: createGrokRuntime({
            command: grok.command,
            models: catalog.models,
            defaultModel: catalog.defaultModel,
            toolShim: ctx.toolShim,
            grokHomes: defaultGrokHomes(ctx.home),
            onAgentSessionRef: (sessionId, ref) => ctx.onAgentSessionRef(sessionId, ref),
            onOptions: (sessionId, reported) => ctx.onOptions(sessionId, reported)
          }),
          readiness: grokReadiness(grok.command, ctx.env as NodeJS.ProcessEnv),
          hint: grok.hint,
          installer: grokInstaller(),
          summary: `Grok 认得 ${catalog.models.length} 个模型（默认 ${catalog.defaultModel || 'Grok 自己的默认'}）`
        }
      ];
    }
  };
}
