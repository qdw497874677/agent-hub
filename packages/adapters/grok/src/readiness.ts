import { execFailureReason, execProbe } from '@agent-hub/adapter-acp';
import type { HarnessProbe, HarnessReadiness } from '@agent-hub/domain';

/** `grok models` 的输出：首行说登没登录，下面 `* id (default)` / `- id` 一行一个模型。 */
export function parseGrokModels(output: string): { authenticated: boolean; models: string[]; defaultModel: string } {
  const models: string[] = [];
  let defaultModel = '';
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*[*-]\s+(\S+)(\s+\(default\))?\s*$/.exec(line);
    if (!match?.[1]) continue;
    models.push(match[1]);
    if (match[2]) defaultModel = match[1];
  }
  return { authenticated: !/not authenticated|not logged in/i.test(output), models, defaultModel };
}

/**
 * Grok 的就绪探测：和 runtime 同一条命令（GROK_COMMAND）。`grok models` 不联网、不到一秒，
 * 告诉我们登没登录；带了 XAI_API_KEY 时 runtime 走无头认证，没登录也能用。
 */
export function grokReadiness(command = 'grok', env: NodeJS.ProcessEnv = process.env, timeoutMs = 15_000): HarnessReadiness {
  return {
    agentId: 'grok',
    async probe(): Promise<HarnessProbe> {
      const result = await execProbe(command, ['--no-auto-update', 'models'], timeoutMs);
      if (result.kind !== 'ok') return { readiness: { state: 'unavailable', reason: execFailureReason(result) }, models: [], defaultModel: '' };
      const parsed = parseGrokModels(result.stdout);
      const ready = parsed.authenticated || Boolean(env['XAI_API_KEY']);
      return {
        readiness: ready ? { state: 'ready' } : { state: 'unavailable', reason: '未登录' },
        models: parsed.models,
        defaultModel: parsed.defaultModel
      };
    }
  };
}
