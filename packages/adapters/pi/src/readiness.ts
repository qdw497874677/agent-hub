import type { HarnessProbe, HarnessReadiness } from '@agent-hub/domain';
import { discoverPiModels } from './discover-models.ts';
import { execFailureReason, execProbe } from './exec-probe.ts';

/**
 * Pi 的就绪探测：和 runtime 同一条命令（PI_COMMAND）。先 `--version` 确认装了，
 * 再问一次它认得的模型——一个都没有说明还没配 provider / 登录。
 */
export function piReadiness(command = 'pi', preferred = '', timeoutMs = 15_000): HarnessReadiness {
  return {
    agentId: 'pi',
    async probe(): Promise<HarnessProbe> {
      const version = await execProbe(command, ['--version'], timeoutMs);
      if (version.kind !== 'ok') return { readiness: { state: 'unavailable', reason: execFailureReason(version) }, models: [], defaultModel: '' };
      const catalog = await discoverPiModels(command, preferred, timeoutMs);
      if (catalog.models.length === 0) return { readiness: { state: 'unavailable', reason: '未配置模型' }, models: [], defaultModel: '' };
      return { readiness: { state: 'ready' }, models: catalog.models, defaultModel: catalog.defaultModel };
    }
  };
}
