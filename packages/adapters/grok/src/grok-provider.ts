import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AcpLaunch } from '@agent-hub/adapter-acp';
import { PROVIDER_TOKEN_ENV, type ProviderLaunch, type ProviderProtocol } from '@agent-hub/domain';

/**
 * Grok 用 hub 模型提供商（ADR 0013 D6）：Grok 的覆盖层不收 model.* 表，只能给这个会话一个私有 GROK_HOME，
 * 里面的 config.toml 只写本机中继地址和 env_key 的名字（令牌值只在 agent 的环境变量里）。
 * 恢复会话要同一个 GROK_HOME，所以目录按会话 id 固定、跟会话同寿命；不碰 ~/.grok。
 */
const BACKEND: Record<ProviderProtocol, string> = { 'openai-chat': 'chat_completions', 'openai-responses': 'responses', anthropic: 'messages' };

const str = (value: string) => JSON.stringify(value);

export function grokProviderToml(launch: ProviderLaunch): string {
  const provider = `hub-${launch.slug}`;
  const lines = ['# agent-hub：这次会话的 hub 模型提供商（不含密钥）', '[cli]', 'auto_update = false', '', `[model_providers.${str(provider)}]`, `base_url = ${str(launch.baseUrl)}`, `api_backend = ${str(BACKEND[launch.protocol])}`, ''];
  for (const model of launch.models) {
    lines.push(`[model.${str(`${provider}/${model.id}`)}]`, `model = ${str(model.id)}`, `model_provider = ${str(provider)}`, `env_key = ${str(PROVIDER_TOKEN_ENV)}`);
    if (launch.protocol === 'anthropic') lines.push(`env_http_headers = { "x-api-key" = ${str(PROVIDER_TOKEN_ENV)} }`);
    if (model.contextWindow) lines.push(`context_window = ${Math.floor(model.contextWindow)}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function defaultGrokHomes(home = homedir()): string {
  return join(home, '.local', 'state', 'agent-hub', 'grok-homes');
}

export function grokProviderLaunch(root: string = defaultGrokHomes()) {
  return async (sessionId: string, launch: ProviderLaunch, base: AcpLaunch): Promise<AcpLaunch> => {
    const dir = join(root, sessionId.replace(/[^A-Za-z0-9_-]/g, '_'));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'config.toml'), grokProviderToml(launch), { mode: 0o600 });
    return { ...base, env: { ...base.env, GROK_HOME: dir, [PROVIDER_TOKEN_ENV]: launch.token } };
  };
}
