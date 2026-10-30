import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeAdapter, RuntimeAdapterContext } from '@agent-hub/domain';
import { createPiRuntime } from './pi-runtime.ts';
import { discoverPiModels } from './discover-models.ts';
import { piReadiness } from './readiness.ts';
import { piInstaller } from './installer.ts';

/** 显式覆盖：`PI_DEFAULT_MODEL=a,b`。除此之外一律问 Pi 自己（裸模型名在多个 provider 下会被 Pi 拒绝）。 */
export function explicitPiModels(env: RuntimeAdapterContext['env']): string[] {
  const explicit = env['PI_DEFAULT_MODEL'];
  if (explicit === undefined || explicit === '') return [];
  return explicit
    .split(',')
    .map((model) => model.trim())
    .filter((model) => model !== '');
}

/** Pi settings 里的 defaultModel 只有 id，没有 provider——用它告诉发现流程「优先选哪个」。只读。 */
export function piPreferredModel(home: string): string {
  try {
    const settings = JSON.parse(readFileSync(join(home, '.pi', 'agent', 'settings.json'), 'utf8')) as { defaultModel?: unknown };
    return typeof settings.defaultModel === 'string' ? settings.defaultModel : '';
  } catch {
    return '';
  }
}

export function piAdapter(): RuntimeAdapter {
  return {
    id: 'pi',
    async prepare(ctx) {
      const pi = ctx.command('pi', 'PI_COMMAND');
      const explicit = explicitPiModels(ctx.env);
      const discovered =
        explicit.length > 0 ? { models: explicit, defaultModel: explicit[0] ?? '' } : await discoverPiModels(pi.command, piPreferredModel(ctx.home));
      const sessionDir = ctx.env['PI_SESSION_DIR'];
      return [
        {
          runtime: createPiRuntime({
            command: pi.command,
            ...(sessionDir ? { sessionDir } : {}),
            models: discovered.models,
            defaultModel: discovered.defaultModel,
            toolShim: ctx.toolShim,
            onAgentSessionRef: (sessionId, ref) => ctx.onAgentSessionRef(sessionId, ref),
            onOptions: (sessionId, reported) => ctx.onOptions(sessionId, reported)
          }),
          readiness: piReadiness(pi.command, discovered.defaultModel),
          hint: pi.hint,
          installer: piInstaller(),
          summary: `Pi 认得 ${discovered.models.length} 个模型（默认 ${discovered.defaultModel || 'Pi 自己的默认'}）`
        }
      ];
    }
  };
}
