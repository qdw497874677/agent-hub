import { spawn } from 'node:child_process';
import { constants } from 'node:os';

/**
 * 在工作空间里跑项目配置的准备命令（docs/design/worktree.md §4 / §8）。
 *
 * 安全边界：
 * - 只用 `/bin/sh -lc`，命令本身来自项目配置，不接受逐次传入；
 * - 环境变量走白名单，`HUB_TOKEN` 之类的秘密一个都不带；
 * - `detached: true` 让命令自成一个进程组，超时能整组杀掉（命令的孙进程也不会漏）；
 * - 输出只留最后 8KB，返回前把 `user:token@` 抹掉。
 */
export interface SetupScriptInput {
  readonly path: string;
  readonly command: string;
  readonly timeoutMs: number;
  /** 额外注入的变量（AGENT_HUB_*），不会覆盖白名单里的值，也带不进被剔除的秘密。 */
  readonly env?: Readonly<Record<string, string>>;
}

export interface SetupScriptOutcome {
  readonly exitCode: number;
  readonly output: string;
  readonly timedOut: boolean;
}

/** 允许命令看到的环境变量：够它找到工具链和 locale，别的（尤其 hub 的秘密）不给。 */
export const SETUP_ENV_ALLOWLIST = ['PATH', 'HOME', 'SHELL', 'LANG', 'TERM'] as const;

/** 无论如何都不能出现在准备命令环境里的变量。 */
export const SETUP_ENV_DENIED = ['HUB_TOKEN', 'HUB_WORKER_CREDENTIAL', 'HUB_LOCAL_SECRET', 'HUB_URL', 'HUB_PARENT_PID'] as const;

export const SETUP_OUTPUT_MAX = 8 * 1024;
const KILL_GRACE_MS = 3000;
const TIMEOUT_EXIT_CODE = 124;

/** 白名单环境 + 允许的额外变量；剔除名单最后再兜一遍（防止上游把这些名字混进 extras）。 */
export function setupEnv(
  extras: Readonly<Record<string, string>> | undefined,
  base: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of SETUP_ENV_ALLOWLIST) {
    const value = base[name];
    if (typeof value === 'string') env[name] = value;
  }
  if (extras) for (const [name, value] of Object.entries(extras)) if (typeof value === 'string') env[name] = value;
  for (const name of SETUP_ENV_DENIED) delete env[name];
  return env;
}

/** 日志里抹掉 `user:token@`（远程 URL 里的凭据）。 */
export function scrubCredentials(text: string): string {
  return text.replace(/([A-Za-z][A-Za-z0-9_.\-]*):([^\s@/]{4,})@/g, '$1:***@');
}

/** 只留最后 8KB（按字符切，避免把多字节字符切坏）。 */
export function tailOutput(text: string, max = SETUP_OUTPUT_MAX): string {
  return text.length <= max ? text : text.slice(-max);
}

/**
 * 跑准备命令。超时整组 SIGTERM → 3s → SIGKILL，返回 exitCode 124 / timedOut: true。
 * 目录边界由调用方（git-workspace.ts 的 guard）先校验，这里只负责执行。
 */
export async function runSetupScript(input: SetupScriptInput): Promise<SetupScriptOutcome> {
  const env = setupEnv(input.env);
  return new Promise<SetupScriptOutcome>((resolve) => {
    let output = '';
    let settled = false;
    let timedOut = false;
    let escalate: NodeJS.Timeout | null = null;

    const child = spawn('/bin/sh', ['-lc', input.command], {
      cwd: input.path,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const append = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      // 留两倍余量，最后再按字符截断。
      if (output.length > SETUP_OUTPUT_MAX * 4) output = output.slice(-SETUP_OUTPUT_MAX * 2);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* 已经没了 */
        }
      }
    };

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (escalate) clearTimeout(escalate);
      if (timer) clearTimeout(timer);
      resolve({ exitCode, output: tailOutput(scrubCredentials(output)), timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      escalate = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    }, Math.max(1, input.timeoutMs));

    child.on('error', (error) => {
      output += `\n${error.message}`;
      finish(127);
    });
    child.on('close', (code, signal) => {
      if (timedOut) return finish(TIMEOUT_EXIT_CODE);
      if (typeof code === 'number') return finish(code);
      // 被信号杀掉：按 shell 的惯例报 128 + 信号序号。
      finish(signal ? 128 + (constants.signals[signal] ?? 0) : 1);
    });
  });
}
