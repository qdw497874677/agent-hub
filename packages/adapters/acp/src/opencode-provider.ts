import { execFile } from 'node:child_process';
import { PROVIDER_MODEL_EXTRA_FORBIDDEN_KEYS, PROVIDER_TOKEN_ENV, type ProviderLaunch, type ProviderModel } from '@agent-hub/domain';
import { mergeConfig, type AcpLaunch } from './config.ts';

/**
 * OpenCode 用 hub 模型提供商（ADR 0013）：深合并进 OPENCODE_CONFIG_CONTENT。
 * 配置里只有本机中继地址和 `{env:HUB_PROVIDER_TOKEN}` 这类引用，令牌值只进 agent 的 env。
 * v1（1.x）用 `provider`，v2 用 `providers`；方言按 `opencode --version` 的大版本选。
 */
export type OpencodeDialect = 'v1' | 'v2';

/**
 * 提供商模型配置的 extra：并进该模型的配置对象（opencode 允许任意附加字段）。
 * 会话控制字段（model / messages / input / stream / …）由 agent 自己决定，一律丢掉；
 * name / limit 由下面显式写入，所以调用处放在 extra 之后展开——extra 覆盖不了它们。
 */
function modelExtra(model: ProviderModel): Record<string, unknown> {
  if (!model.extra) return {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(model.extra)) {
    if (PROVIDER_MODEL_EXTRA_FORBIDDEN_KEYS.includes(key)) continue;
    extra[key] = value;
  }
  return extra;
}

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
          models: Object.fromEntries(
            launch.models.map((model) => [model.id, { ...modelExtra(model), name: model.name ?? model.id }])
          )
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
            {
              ...modelExtra(model),
              name: model.name ?? model.id,
              ...(model.contextWindow ? { limit: { context: model.contextWindow, output: model.maxTokens ?? 8192 } } : {})
            }
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
