import { execFile } from 'node:child_process';
import { PROVIDER_TOKEN_ENV, type ProviderLaunch } from '@agent-hub/domain';
import { mergeConfig, type AcpLaunch } from './config.ts';

/**
 * OpenCode 用 hub 模型提供商（ADR 0013）：深合并进 OPENCODE_CONFIG_CONTENT。
 * 配置里只有本机中继地址和 `{env:HUB_PROVIDER_TOKEN}` 这类引用，令牌值只进 agent 的 env。
 * v1（1.x）用 `provider`，v2 用 `providers`；方言按 `opencode --version` 的大版本选。
 */
export type OpencodeDialect = 'v1' | 'v2';

export function opencodeProviderConfig(launch: ProviderLaunch, dialect: OpencodeDialect): Record<string, unknown> {
  const id = `hub-${launch.slug}`;
  if (dialect === 'v2') {
    const pkg =
      launch.protocol === 'anthropic'
        ? '@opencode/ai/providers/anthropic-compatible'
        : launch.protocol === 'openai-responses'
          ? '@opencode/ai/providers/openai-compatible/responses'
          : '@opencode/ai/providers/openai-compatible';
    return {
      providers: {
        [id]: {
          name: launch.name,
          env: [PROVIDER_TOKEN_ENV],
          package: pkg,
          settings: { baseURL: launch.baseUrl },
          models: Object.fromEntries(launch.models.map((model) => [model.id, { name: model.name ?? model.id }]))
        }
      }
    };
  }
  const npm = launch.protocol === 'anthropic' ? '@ai-sdk/anthropic' : launch.protocol === 'openai-responses' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible';
  return {
    provider: {
      [id]: {
        npm,
        name: launch.name,
        options: { baseURL: launch.baseUrl, apiKey: `{env:${PROVIDER_TOKEN_ENV}}` },
        models: Object.fromEntries(
          launch.models.map((model) => [
            model.id,
            { name: model.name ?? model.id, ...(model.contextWindow ? { limit: { context: model.contextWindow, output: model.maxTokens ?? 8192 } } : {}) }
          ])
        )
      }
    }
  };
}

export function opencodeDialect(versionText: string): OpencodeDialect {
  const major = Number(/(\d+)\.\d+/.exec(versionText)?.[1] ?? '1');
  return major >= 2 ? 'v2' : 'v1';
}

function detect(command: string): Promise<OpencodeDialect> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 10_000 }, (error, stdout) => resolve(error ? 'v1' : opencodeDialect(String(stdout))));
  });
}

export function opencodeProviderLaunch(command: string, dialect?: () => Promise<OpencodeDialect>) {
  let cached: Promise<OpencodeDialect> | null = null;
  const which = dialect ?? (() => (cached ??= detect(command)));
  return async (_sessionId: string, launch: ProviderLaunch, base: AcpLaunch): Promise<AcpLaunch> => {
    const existing = base.env?.['OPENCODE_CONFIG_CONTENT'] ?? process.env['OPENCODE_CONFIG_CONTENT'];
    let user: Record<string, unknown> = {};
    try {
      const parsed: unknown = existing ? JSON.parse(existing) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) user = parsed as Record<string, unknown>;
    } catch {
      user = {};
    }
    const content = mergeConfig(user, opencodeProviderConfig(launch, await which()));
    return { ...base, env: { ...base.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(content), [PROVIDER_TOKEN_ENV]: launch.token } };
  };
}
