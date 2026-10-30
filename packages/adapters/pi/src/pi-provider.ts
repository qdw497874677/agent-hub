import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_TOKEN_ENV, type ProviderLaunch, type ProviderProtocol } from '@agent-hub/domain';

/**
 * Pi 用 hub 模型提供商（ADR 0013）：每个会话一个 `-e` 扩展文件，registerProvider("hub-<slug>")。
 * 文件里只有本机中继地址和模型清单；令牌用 "$HUB_PROVIDER_TOKEN" 引用，值只在 agent 进程的环境变量里。
 * 不碰 ~/.pi/agent/models.json / settings.json。
 */
const PI_API: Record<ProviderProtocol, string> = {
  'openai-chat': 'openai-completions',
  'openai-responses': 'openai-responses',
  anthropic: 'anthropic-messages'
};

export function piProviderSource(launch: ProviderLaunch): string {
  const config = {
    name: launch.name,
    baseUrl: launch.baseUrl,
    apiKey: `$${PROVIDER_TOKEN_ENV}`,
    api: PI_API[launch.protocol],
    models: launch.models.map((model) => ({
      type: 'chat',
      id: model.id,
      name: model.name ?? model.id,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? 128000,
      maxTokens: model.maxTokens ?? 16384
    }))
  };
  return `// agent-hub：这次会话的 hub 模型提供商（不含密钥）\nexport default function (pi) {\n  pi.registerProvider(${JSON.stringify(`hub-${launch.slug}`)}, ${JSON.stringify(config, null, 2)});\n}\n`;
}

/** 写好扩展文件，返回要加的参数和环境变量。 */
export async function piProviderLaunch(sessionId: string, launch: ProviderLaunch, root = join(tmpdir(), 'agent-hub-providers')): Promise<{ args: string[]; env: Record<string, string> }> {
  const dir = join(root, sessionId.replace(/[^A-Za-z0-9_-]/g, '_'));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'hub-provider.ts');
  await writeFile(file, piProviderSource(launch), { mode: 0o600 });
  return { args: ['-e', file], env: { [PROVIDER_TOKEN_ENV]: launch.token } };
}
