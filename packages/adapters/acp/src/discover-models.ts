import { execFile } from 'node:child_process';
import type { AcpAgentConfig } from './config.ts';

/** `opencode models` 这类输出：每行一个 `provider/model`，空行与带空白的说明行都跳过。 */
export function parseModelLines(output: string): string[] {
  const models = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/\s/.test(line) && line.includes('/'));
  return [...new Set(models)];
}

/**
 * 启动时问一次 agent 认得哪些模型。没配 listModelsArgs、没装、超时、报错，一律返回空清单——
 * 模型清单只是派生对话框里的候选，不该因为它让 worker 起不来。
 */
export function discoverAcpModels(config: AcpAgentConfig, timeoutMs = 15_000): Promise<string[]> {
  const args = config.listModelsArgs;
  if (args === undefined) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(config.command, [...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? [] : parseModelLines(String(stdout)));
    });
  });
}
