import { spawn } from 'node:child_process';
import { jsonlRecords } from '@agent-hub/contract';
import { GROK_ARGS } from './grok-runtime.ts';

export interface GrokModelCatalog {
  readonly models: string[];
  readonly defaultModel: string;
}

/** 纯函数：从 ACP initialize 结果的 `_meta.modelState` 里取模型列表。 */
export function modelsFromInitialize(result: unknown): GrokModelCatalog {
  const meta = (result as { _meta?: { modelState?: unknown } } | null)?._meta;
  const state = meta?.modelState as
    | { currentModelId?: unknown; availableModels?: unknown }
    | undefined;
  const models: string[] = [];
  for (const entry of Array.isArray(state?.availableModels) ? state.availableModels : []) {
    const id = (entry as { modelId?: unknown } | null)?.modelId;
    if (typeof id === 'string' && id !== '') models.push(id);
  }
  const current = typeof state?.currentModelId === 'string' ? state.currentModelId : '';
  return { models, defaultModel: models.includes(current) ? current : (models[0] ?? '') };
}

/**
 * 启一次 `grok agent stdio`，只发 initialize 就收。没装 grok 或超时都返回空目录，
 * worker 照常启动——Grok 用自己的默认模型。
 */
export async function discoverGrokModels(
  command = 'grok',
  timeoutMs = 15_000
): Promise<GrokModelCatalog> {
  const empty: GrokModelCatalog = { models: [], defaultModel: '' };
  let child;
  try {
    child = spawn(command, [...GROK_ARGS], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return empty;
  }
  child.on('error', () => undefined);
  child.stdin.on('error', () => undefined);
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
        }
      })}\n`
    );
    for await (const line of jsonlRecords(child.stdout)) {
      let record: { id?: unknown; result?: unknown };
      try {
        record = JSON.parse(line) as { id?: unknown; result?: unknown };
      } catch {
        continue;
      }
      if (record.id === 1) return modelsFromInitialize(record.result);
    }
    return empty;
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
  }
}
