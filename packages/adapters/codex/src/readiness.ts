import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessProbe, HarnessReadiness } from '@agent-hub/domain';
import {
  CODEX_FALLBACK_DEFAULT_MODEL,
  CODEX_FALLBACK_MODELS,
  fallbackCodexCatalog
} from './discover-models.ts';

export interface CodexReadinessOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly timeoutMs?: number;
  readonly models?: readonly string[];
  readonly defaultModel?: string;
}

type ProbeResult =
  | { readonly kind: 'ok'; readonly stdout: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed'; readonly code: number | null };

/**
 * Codex 的就绪条件：`codex --version` 能跑，且至少有 `OPENAI_API_KEY` 或
 * `~/.codex/auth.json`（`codex login` 的产物）。真实模型联调留给用户，这里只判「装没装、登没登」。
 */
export function codexReadiness(command = 'codex', options: CodexReadinessOptions = {}): HarnessReadiness {
  const env = options.env ?? process.env;
  const home = options.home ?? env['HOME'] ?? '';
  return {
    agentId: 'codex',
    async probe(): Promise<HarnessProbe> {
      const timeoutMs = options.timeoutMs ?? 15_000;
      const version = await probe(command, ['--version'], timeoutMs);
      if (version.kind === 'missing') {
        return unavailable('没装 codex（mise use -g codex@0.168.0）', '装好后重开 worker：mise use -g codex@0.168.0');
      }
      if (version.kind === 'timeout') {
        return unavailable('检测 codex 超时了', '手动跑一次 `codex --version` 看看是不是卡住了');
      }
      if (version.kind === 'failed') {
        return unavailable(
          `codex --version 失败了（退出码 ${version.code ?? 'unknown'}）`,
          '手动跑一次 `codex --version` 看报错'
        );
      }
      const hasKey = (env['OPENAI_API_KEY'] ?? '').trim() !== '';
      const hasAuthFile = home !== '' && existsSync(join(home, '.codex', 'auth.json'));
      if (!hasKey && !hasAuthFile) {
        return unavailable(
          '还没登录：在 worker 的 env 里给 OPENAI_API_KEY，或跑 codex login',
          '在 worker 的 env 里给 OPENAI_API_KEY，或跑 codex login'
        );
      }
      const catalog = fallbackCodexCatalog();
      return {
        readiness: { state: 'ready' },
        models: options.models ?? catalog.models,
        defaultModel: options.defaultModel ?? (options.models?.[0] ?? CODEX_FALLBACK_DEFAULT_MODEL)
      };
    }
  };
}

function unavailable(reason: string, hint: string): HarnessProbe {
  return {
    readiness: { state: 'unavailable', reason, hint },
    models: [],
    defaultModel: ''
  };
}

function probe(command: string, args: readonly string[], timeoutMs: number): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error === null) {
        resolve({ kind: 'ok', stdout });
        return;
      }
      const record = error as unknown as { readonly code?: unknown; readonly killed?: unknown };
      if (record.code === 'ENOENT') {
        resolve({ kind: 'missing' });
        return;
      }
      if (record.code === 'ETIMEDOUT' || record.killed === true) {
        resolve({ kind: 'timeout' });
        return;
      }
      resolve({ kind: 'failed', code: typeof record.code === 'number' ? record.code : null });
    });
  });
}

export { CODEX_FALLBACK_MODELS };
