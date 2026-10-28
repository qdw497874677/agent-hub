import type { HarnessProbe, HarnessReadiness } from '@agent-hub/domain';
import type { AcpAgentConfig } from './config.ts';
import { parseModelLines } from './discover-models.ts';
import { execFailureReason, execProbe } from './exec-probe.ts';

/**
 * 通用 ACP agent（OpenCode 等）的就绪探测：和 runtime 用同一份 config（同一条命令）。
 * 有 listModelsArgs 就列模型——列不出任何模型 = 没配 provider；没有就只确认命令在。
 */
export function acpReadiness(config: AcpAgentConfig, timeoutMs = 15_000): HarnessReadiness {
  return {
    agentId: config.id,
    async probe(): Promise<HarnessProbe> {
      const listing = config.listModelsArgs;
      const result = await execProbe(config.command, listing ?? ['--version'], timeoutMs);
      if (result.kind !== 'ok') return { readiness: { state: 'unavailable', reason: execFailureReason(result) }, models: [], defaultModel: '' };
      if (listing === undefined) return { readiness: { state: 'ready' }, models: [], defaultModel: '' };
      const models = parseModelLines(result.stdout);
      if (models.length === 0) return { readiness: { state: 'unavailable', reason: '未配置模型' }, models, defaultModel: '' };
      return { readiness: { state: 'ready' }, models, defaultModel: models[0] ?? '' };
    }
  };
}
