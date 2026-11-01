import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseHubModel, PROVIDER_BASE_URL_ENV, PROVIDER_TOKEN_ENV, type ProviderLaunch } from '@agent-hub/domain';
import type { AcpAgentConfig, AcpLaunch } from './config.ts';

/**
 * ADR 0022 D7 回退：共用网关分不清会话（session key 不转给 MCP，设计 §14.3），
 * 要 hub MCP 的会话走 `hermes acp`——一会话一进程，ACP session/new 的 mcpServers 是会话级的。
 * 每会话一个独立 HERMES_HOME（不碰共用网关的 home，也不碰用户的 ~/.hermes），config 只引用环境变量名。
 */
export function hermesAcpHome(root: string, sessionId: string): string {
  return join(root, 'acp', `ahub-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`);
}

export function hermesAcpModelConfig(launch: ProviderLaunch): Record<string, unknown> {
  return {
    model: {
      provider: 'custom',
      default: launch.models[0]?.id ?? 'ahub-unset',
      base_url: `\${${PROVIDER_BASE_URL_ENV}}`,
      api_key: `\${${PROVIDER_TOKEN_ENV}}`
    },
    memory: { memory_enabled: false, user_profile_enabled: false },
    // hermes acp 会在这个 home 自动拉起一个 `gateway run --idle-exit`（约 270MB），默认闲 600 秒才退；
    // 一会话一 home，留着就是一堆空转进程——闲 60 秒就退（会话还在用时它不算闲）。
    gateway: { unmanaged_idle_exit_seconds: 60 }
  };
}

export function hermesAcpProviderLaunch(root: string) {
  return async (sessionId: string, launch: ProviderLaunch, base: AcpLaunch): Promise<AcpLaunch> => {
    const home = hermesAcpHome(root, sessionId);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, 'config.yaml'), `${JSON.stringify(hermesAcpModelConfig(launch), null, 2)}\n`, { mode: 0o600 });
    return {
      ...base,
      env: { ...base.env, HERMES_HOME: home, [PROVIDER_BASE_URL_ENV]: launch.baseUrl, [PROVIDER_TOKEN_ENV]: launch.token }
    };
  };
}

/**
 * Hermes ACP 的模型 id 是「custom:<模型>」（config.yaml 里 provider: custom）；hub 下发的是「hub-<slug>/<模型>」。
 * 不换的话 set_model 会把 Hermes 切到一个它不认识的模型。
 */
export function hermesAcpOptionValue(id: string, value: string | boolean): string | boolean {
  if (id !== 'model' || typeof value !== 'string') return value;
  const hub = parseHubModel(value);
  return hub ? `custom:${hub.modelId}` : value;
}

/** 只在 Hermes 开了（HERMES_COMMAND 或 WORKER_HERMES=1）才加；只用 hub 模型（没有本机凭据可用）。 */
export function hermesAcpConfig(env: Readonly<Record<string, string | undefined>>, home = homedir()): AcpAgentConfig | null {
  if (!env['HERMES_COMMAND'] && env['WORKER_HERMES'] !== '1') return null;
  const root = env['HERMES_HUB_ROOT'] || join(home, '.local', 'state', 'agent-hub', 'hermes');
  return {
    id: 'hermes-acp',
    label: 'Hermes（ACP，带 hub 工具）',
    command: env['HERMES_COMMAND'] || 'hermes',
    args: ['acp'],
    // 没选 hub 模型时也不碰用户的 ~/.hermes：给一个空 home（没凭据，跑不起来就报错，不偷用本机配置）
    launch: () => ({ env: { HERMES_HOME: join(root, 'acp', '_unrouted') } }),
    providerProtocols: ['openai-chat'],
    providerLaunch: hermesAcpProviderLaunch(root),
    optionValue: hermesAcpOptionValue
  };
}
