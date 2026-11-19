import { e2eHubModel } from './hub-model.ts';

/**
 * 真 OpenCode 用例用的模型。
 * - 设置了 `E2E_HUB_MODEL`（例如 hub-cn-glm-flash/glm-5.3-flash）：走 Hub 托管供应商，绝不回落到本机原生 / Go 模型。
 * - 没设置：保持原来的真机回归写法（本机 OpenCode 里配置的 my-codex 供应商）。
 */
export const OPENCODE_NATIVE_MODEL = 'my-codex/go-deepseek-v4.1-flash';

export function opencodeModel(): string {
  return e2eHubModel() || OPENCODE_NATIVE_MODEL;
}

/** Hub 模型不在 Worker 上报的原生模型清单里：只要求 Worker 报了 opencode 运行时。 */
export function opencodeReady(entry: { models?: string[] } | undefined, model: string): boolean {
  if (!entry) return false;
  return e2eHubModel() ? true : Boolean(entry.models?.includes(model));
}
