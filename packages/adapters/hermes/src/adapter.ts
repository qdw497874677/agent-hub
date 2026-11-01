import type { RuntimeAdapter } from '@agent-hub/domain';
import { defaultHermesRoot } from './home.ts';
import { createHermesRuntime } from './hermes-runtime.ts';
import { hermesReadiness } from './readiness.ts';

/**
 * Hermes（ADR 0022 P1）默认不开：设了 HERMES_COMMAND 或 WORKER_HERMES=1 才注册。
 * 每会话的 HERMES_HOME 放在 HERMES_HUB_ROOT（默认 ~/.local/state/agent-hub/hermes），不碰用户自己的 ~/.hermes。
 */
export function hermesAdapter(): RuntimeAdapter {
  return {
    id: 'hermes',
    async prepare(ctx) {
      if (!ctx.env['HERMES_COMMAND'] && ctx.env['WORKER_HERMES'] !== '1') return [];
      const hermes = ctx.command('hermes', 'HERMES_COMMAND');
      return [
        {
          runtime: createHermesRuntime({
            command: hermes.command,
            root: ctx.env['HERMES_HUB_ROOT'] || defaultHermesRoot(ctx.home),
            toolShim: ctx.toolShim,
            log: (message) => ctx.log(message),
            onAgentSessionRef: (sessionId, ref) => ctx.onAgentSessionRef(sessionId, ref)
          }),
          readiness: hermesReadiness(hermes.command),
          hint: hermes.hint,
          summary: 'Hermes 走 Runs API，只用 hub 模型提供商'
        }
      ];
    }
  };
}
