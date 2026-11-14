import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CODEX_CLIENT_VERSION, JsonRpcPeer } from './jsonrpc.ts';

export interface CodexModelCatalog {
  readonly models: string[];
  readonly defaultModel: string;
  readonly defaultEffort: string;
  /** app-server 真的答了 / 探测失败退回静态清单。 */
  readonly source: 'app-server' | 'fallback';
}

/**
 * 探不到 `model/list` 时用的静态清单。Codex 的模型名会变，所以这只在
 * 没装 codex / 没登录 / app-server 起不来时兜底；真会话里 Codex 认什么仍以它自己的答复为准。
 */
export const CODEX_FALLBACK_MODELS: readonly string[] = ['gpt-5.1-codex', 'gpt-5.1', 'gpt-5-codex'];
export const CODEX_FALLBACK_DEFAULT_MODEL = 'gpt-5.1-codex';
export const CODEX_FALLBACK_EFFORT = 'medium';

export function fallbackCodexCatalog(): CodexModelCatalog {
  return {
    models: [...CODEX_FALLBACK_MODELS],
    defaultModel: CODEX_FALLBACK_DEFAULT_MODEL,
    defaultEffort: CODEX_FALLBACK_EFFORT,
    source: 'fallback'
  };
}

/**
 * 启一次 `codex app-server`，握手后问 `model/list` 再收掉。没装 / 超时 / 报错
 * 都返回静态清单，worker 照常启动。
 */
export async function discoverCodexModels(command = 'codex', timeoutMs = 15_000): Promise<CodexModelCatalog> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
  } catch {
    return fallbackCodexCatalog();
  }
  child.on('error', () => undefined);
  child.stdin.on('error', () => undefined);

  const started = await new Promise<boolean>((resolve) => {
    let settled = false;
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      resolve(true);
    });
    child.once('error', () => {
      if (settled) return;
      settled = true;
      resolve(false);
    });
  });
  if (!started) return fallbackCodexCatalog();

  const peer = new JsonRpcPeer({ input: child.stdout, output: child.stdin, defaultTimeoutMs: timeoutMs });
  const timer = setTimeout(() => killGroup(child, 'SIGKILL'), timeoutMs + 1_000);
  timer.unref?.();
  try {
    await peer.request(
      'initialize',
      { clientInfo: { name: 'agent-hub', version: CODEX_CLIENT_VERSION }, capabilities: {} },
      timeoutMs
    );
    peer.notify('initialized');
    const response = await peer.request('model/list', {}, timeoutMs);
    return catalogFromModelList(response);
  } catch {
    return fallbackCodexCatalog();
  } finally {
    clearTimeout(timer);
    peer.close('模型探测结束');
    killGroup(child, 'SIGKILL');
  }
}

/** 纯函数：`ModelListResponse.data` → 模型清单（跳过 hidden）。 */
export function catalogFromModelList(response: unknown): CodexModelCatalog {
  const data = asRecord(response)['data'];
  if (!Array.isArray(data)) return fallbackCodexCatalog();
  const models: string[] = [];
  let chosen = '';
  let effort = '';
  for (const entry of data) {
    const model = asRecord(entry);
    const id = typeof model['id'] === 'string' ? model['id'] : '';
    if (id === '' || model['hidden'] === true) continue;
    models.push(id);
    if (model['isDefault'] === true) {
      chosen = id;
      effort = typeof model['defaultReasoningEffort'] === 'string' ? model['defaultReasoningEffort'] : '';
    }
  }
  if (models.length === 0) return fallbackCodexCatalog();
  const defaultModel = models.includes(chosen) ? chosen : models[0]!;
  if (defaultModel !== chosen) {
    const entry = data.map(asRecord).find((model) => model['id'] === defaultModel);
    effort = typeof entry?.['defaultReasoningEffort'] === 'string' ? entry['defaultReasoningEffort'] : '';
  }
  return { models, defaultModel, defaultEffort: effort === '' ? CODEX_FALLBACK_EFFORT : effort, source: 'app-server' };
}

function killGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // 不是组长 / 已退出
    }
  }
  try {
    child.kill(signal);
  } catch {
    // 已经退出
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
