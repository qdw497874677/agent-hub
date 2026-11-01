import { execFailureReason, execProbe } from '@agent-hub/adapter-acp';
import type { HarnessProbe, HarnessReadiness } from '@agent-hub/domain';

/** `hermes --version` 能跑就算装好了；模型来自 hub 提供商，这里不报模型。 */
export function hermesReadiness(command = 'hermes', timeoutMs = 15_000): HarnessReadiness {
  return {
    agentId: 'hermes',
    async probe(): Promise<HarnessProbe> {
      const result = await execProbe(command, ['--version'], timeoutMs);
      if (result.kind !== 'ok') return { readiness: { state: 'unavailable', reason: execFailureReason(result) }, models: [], defaultModel: '' };
      return { readiness: { state: 'ready' }, models: [], defaultModel: '' };
    }
  };
}
