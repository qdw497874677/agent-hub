import { MCP_ADAPTER, type HarnessProbe, type HarnessReadiness } from '@agent-hub/domain';
import { discoverPiModels } from './discover-models.ts';
import { execFailureReason, execProbe } from './exec-probe.ts';
import { piHasBuiltinMcp } from './pi-mcp.ts';

/**
 * Pi 的就绪探测：和 runtime 同一条命令（PI_COMMAND）。先 `--version` 确认装了，
 * 再问一次它认得的模型——一个都没有说明还没配 provider / 登录。
 * 最后看 MCP 适配器装没装：缺了只记在 lacks 里，要不要因此判不可用由 hub 按资产决定。
 */
export function piReadiness(command = 'pi', preferred = '', timeoutMs = 15_000): HarnessReadiness {
  return {
    agentId: 'pi',
    async probe(): Promise<HarnessProbe> {
      const version = await execProbe(command, ['--version'], timeoutMs);
      if (version.kind !== 'ok') return { readiness: { state: 'unavailable', reason: execFailureReason(version) }, models: [], defaultModel: '' };
      const catalog = await discoverPiModels(command, preferred, timeoutMs);
      if (catalog.models.length === 0) return { readiness: { state: 'unavailable', reason: '未配置模型' }, models: [], defaultModel: '' };
      // Pi 0.99+ 自带 MCP，不需要适配器。
      if (piHasBuiltinMcp(version.stdout)) return { readiness: { state: 'ready' }, models: catalog.models, defaultModel: catalog.defaultModel };
      // 老 Pi 的 MCP 靠适配器（pi-mcp-adapter，Pi 的扩展包）：`pi list` 列得出来才算装了。列不出来（老版本 / 失败）就不下结论。
      const packages = await execProbe(command, ['list'], timeoutMs);
      const lacks = packages.kind === 'ok' && !/\bpi-mcp-adapter\b/.test(packages.stdout) ? [MCP_ADAPTER] : [];
      return {
        readiness: lacks.length > 0 ? { state: 'ready', lacks } : { state: 'ready' },
        models: catalog.models,
        defaultModel: catalog.defaultModel
      };
    }
  };
}
