import { execFile } from 'node:child_process';

/** 跑一条便宜的探测命令。只区分「没装 / 超时 / 失败 / 成功」，失败原因不带命令输出（可能有敏感信息）。 */
export type ExecProbe =
  | { readonly kind: 'ok'; readonly stdout: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed'; readonly code: number | null };

export function execProbe(command: string, args: readonly string[], timeoutMs: number): Promise<ExecProbe> {
  return new Promise((resolve) => {
    try {
      execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (!error) return resolve({ kind: 'ok', stdout: String(stdout) });
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
        if (failure.code === 'ENOENT') return resolve({ kind: 'missing' });
        if (failure.killed) return resolve({ kind: 'timeout' });
        resolve({ kind: 'failed', code: typeof failure.code === 'number' ? failure.code : null });
      });
    } catch {
      resolve({ kind: 'missing' });
    }
  });
}

/** 探测失败时给人看的中文原因（不含命令输出）。 */
export function execFailureReason(result: Exclude<ExecProbe, { kind: 'ok' }>): string {
  if (result.kind === 'missing') return '未安装';
  if (result.kind === 'timeout') return '检测超时';
  return `检测失败（退出码 ${result.code ?? '未知'}）`;
}
