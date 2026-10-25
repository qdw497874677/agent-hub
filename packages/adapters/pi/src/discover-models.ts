import { spawn } from 'node:child_process';
import { jsonlRecords } from '@agent-hub/contract';

export interface PiModelCatalog {
  /** `provider/id` 形式。Pi 在裸模型名跨多个 provider 有歧义时会拒绝启动，所以这里就带上 provider。 */
  readonly models: readonly string[];
  readonly defaultModel: string;
}

const EMPTY: PiModelCatalog = { models: [], defaultModel: '' };

/**
 * 问 Pi 自己认得哪些模型，而不是由平台去猜或者读它的配置文件。
 *
 * 为什么必须问：裸模型名（`glm-5.3`）在多个 provider 都已认证时会被 Pi 拒绝
 * （`Model "glm-5.3" is ambiguous across providers`），平台无法自己把名字补全。
 * 这也是「模型诚实性」这条设计决定的实现：列表来自 agent，不来自我们的推测。
 *
 * @param command Pi 可执行文件
 * @param preferred 想优先当作默认的那个模型 id（通常是 Pi 自己 settings 里的 default）
 * @param timeoutMs 超时就当没发现——租不到模型不该让 worker 起不来
 *
 * 默认值优先用 Pi `get_state` 里它**此刻真在用的** provider/id，而不是「第一个同名模型」：
 * `glm-5.3` 能在七个 provider 下都叫这个名字，挑错一个不会报错，只会跑到别的计费账号上。
 */
export async function discoverPiModels(
  command = 'pi',
  preferred = '',
  timeoutMs = 15_000
): Promise<PiModelCatalog> {
  const child = spawn(command, ['--mode', 'rpc', '--no-session'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  // 没装 pi 时 spawn 会异步抛 ENOENT；不接住会把整个 worker 崩掉（其它 agent 也跟着下线）。
  child.on('error', () => undefined);
  child.stdin.on('error', () => undefined);

  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

  try {
    child.stdin.write(`${JSON.stringify({ id: 'models', type: 'get_available_models' })}\n`);
    child.stdin.write(`${JSON.stringify({ id: 'state', type: 'get_state' })}\n`);
    child.stdin.end();

    let models: string[] = [];
    const byId = new Map<string, string>();
    let active = '';

    for await (const line of jsonlRecords(child.stdout)) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof record !== 'object' || record === null) continue;
      const response = record as { command?: unknown; data?: unknown };

      if (response.command === 'get_state') {
        const model = (response.data as { model?: unknown } | undefined)?.model as
          | { id?: unknown; provider?: unknown }
          | undefined;
        if (typeof model?.id === 'string' && typeof model.provider === 'string') {
          active = `${model.provider}/${model.id}`;
        }
      } else if (response.command === 'get_available_models') {
        const raw = (response.data as { models?: unknown } | undefined)?.models;
        models = [];
        for (const entry of Array.isArray(raw) ? raw : []) {
          const model = entry as { id?: unknown; provider?: unknown };
          if (typeof model.id !== 'string' || typeof model.provider !== 'string') continue;
          const qualified = `${model.provider}/${model.id}`;
          models.push(qualified);
          if (!byId.has(model.id)) byId.set(model.id, qualified);
        }
      } else {
        continue;
      }

      // 两条应答都到齐再决定默认值；get_state 用的是 Pi 自己的选择，优先级最高。
      if (models.length > 0 && active !== '') {
        const chosen =
          (models.includes(active) ? active : undefined) ??
          (preferred !== '' ? byId.get(preferred) : undefined) ??
          models[0] ??
          '';
        return { models, defaultModel: chosen };
      }
    }
    return models.length > 0 ? { models, defaultModel: models[0] ?? '' } : EMPTY;
  } catch {
    return EMPTY;
  } finally {
    clearTimeout(timer);
    if (!child.killed) child.kill('SIGKILL');
  }
}
