import type { RuntimeAdapter, RuntimeAdapterContext } from '@agent-hub/domain';
import { ACP_AGENT_DEFAULTS, acpDescriptor, opencodeLaunch, type AcpAgentConfig } from './config.ts';
import { createAcpRuntime } from './acp-runtime.ts';
import { discoverAcpModels } from './discover-models.ts';
import { acpReadiness } from './readiness.ts';
import { opencodeInstaller } from './installer.ts';
import { opencodeProviderLaunch } from './opencode-provider.ts';

/**
 * ACP agent 是配置，不是代码：
 * `ACP_AGENTS='[{"id":"claude-code","label":"Claude Code","command":"claude-code-acp","args":[]}]'`
 */
export function acpAgents(raw: string | undefined, log: (message: string) => void = () => undefined): readonly AcpAgentConfig[] {
  if (raw === undefined || raw === '') return ACP_AGENT_DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return ACP_AGENT_DEFAULTS;
    const agents: AcpAgentConfig[] = [];
    for (const entry of parsed) {
      const candidate = entry as Partial<AcpAgentConfig>;
      if (typeof candidate.id !== 'string' || typeof candidate.command !== 'string') continue;
      agents.push({
        id: candidate.id,
        label: typeof candidate.label === 'string' ? candidate.label : candidate.id,
        command: candidate.command,
        args: Array.isArray(candidate.args) ? candidate.args.filter((arg) => typeof arg === 'string') : [],
        ...(Array.isArray(candidate.listModelsArgs)
          ? { listModelsArgs: candidate.listModelsArgs.filter((arg) => typeof arg === 'string') }
          : {})
      });
    }
    return agents.length > 0 ? agents : ACP_AGENT_DEFAULTS;
  } catch {
    log('ACP_AGENTS 不是合法 JSON，回退到默认的 OpenCode');
    return ACP_AGENT_DEFAULTS;
  }
}

/** 命令名对应的环境变量：opencode → OPENCODE_COMMAND，其它按 id 推。 */
export function commandEnvVar(id: string): string {
  return `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_COMMAND`;
}

export function acpConfigsFor(ctx: Pick<RuntimeAdapterContext, 'env' | 'log' | 'components'>): AcpAgentConfig[] {
  return acpAgents(ctx.env['ACP_AGENTS'], ctx.log).map((config) => {
    if (config.id !== 'opencode') return config;
    // OPENCODE_COMMAND 是单机安装的后门；ACP_AGENTS 里自己写的 opencode 条目也照样认 hub 下发的资产
    const override = ctx.env['OPENCODE_COMMAND'];
    const command = override ?? config.command;
    return {
      providerProtocols: ['openai-chat', 'openai-responses', 'anthropic'] as const,
      providerLaunch: opencodeProviderLaunch(command),
      ...config,
      // 每次开会话现查 hub 装的 opencode 组件（插件）；ACP_AGENTS 里自定义的 launch 优先
      launch:
        config.launch && config.launch !== opencodeLaunch
          ? config.launch
          : (assets: Parameters<typeof opencodeLaunch>[0]) => opencodeLaunch(assets, process.env['OPENCODE_CONFIG_CONTENT'], ctx.components?.('opencode') ?? []),
      command
    };
  });
}

export function acpAdapter(): RuntimeAdapter {
  return {
    id: 'acp',
    async prepare(ctx) {
      const resolved = acpConfigsFor(ctx).map((config) => {
        const found = ctx.command(config.command, commandEnvVar(config.id), config.id);
        return { config: { ...config, command: found.command }, hint: found.hint };
      });
      // ACP 只在开了会话之后才报模型；启动时先问一次，派生对话框才有得选。
      const models = await Promise.all(resolved.map(({ config }) => discoverAcpModels(config)));
      return resolved.map(({ config, hint }, index) => ({
        runtime: createAcpRuntime(config, {
          descriptor: acpDescriptor(config, [], models[index] ?? []),
          toolShim: ctx.toolShim,
          onAgentSessionRef: (sessionId, ref) => ctx.onAgentSessionRef(sessionId, ref),
          onOptions: (sessionId, reported) => ctx.onOptions(sessionId, reported)
        }),
        readiness: acpReadiness(config),
        hint,
        // 只给我们认得怎么装的；ACP_AGENTS 里自定义的 agent 不在线安装
        ...(config.id === 'opencode' ? { installer: opencodeInstaller() } : {}),
        summary: `${config.label} 认得 ${models[index]?.length ?? 0} 个模型`
      }));
    }
  };
}
