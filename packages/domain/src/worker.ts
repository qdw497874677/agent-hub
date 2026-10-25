import { conflict, unavailable, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/** Worker 的对外状态。Server / Worker 是适配器，但它得有地方被看见（S1.2）。 */
export type WorkerState = 'online' | 'offline';

export interface WorkerStatus {
  readonly workerId: string;
  readonly label: string;
  readonly origin: 'local' | 'remote';
  readonly state: WorkerState;
  /** offline 时的原因文案：区分「它挂了」和「我改坏了配置」。 */
  readonly reason?: string;
  /** 这台 Worker 报上来的 agent id。落点只能选「装了这个 agent」的那台。 */
  readonly agentIds?: readonly string[];
  readonly hostname?: string;
  readonly platform?: string;
  /** 目录选择器的起点（通常是那台机器的 $HOME）。 */
  readonly roots?: readonly string[];
  /** 最后一次听到它（hello / 心跳 / 任意帧），epoch ms。 */
  readonly lastSeenAt?: number;
  /** 此刻托管在它上面的会话数。 */
  readonly sessionCount?: number;
}

export interface PlacementRequest {
  readonly agentId: string;
  /** 人在对话框里点名的那台；没点名就是 null。 */
  readonly requested: string | null;
  /** 项目目录所在的那台：目录在哪，agent 就只能在哪跑。null = 目录在 Server 本机。 */
  readonly projectWorker: string | null;
}

/**
 * 落点（Placement）：一条新会话该交给哪台 Worker。
 *
 * 领域只持有不透明的 workerId——它不关心那是本机还是另一台机器（见 GLOSSARY「Worker」）。
 * 规则按优先级：项目绑定的机器 > 人点名的 > 和 Server 同机的（local）> 任意一台在线且装了这个 agent 的。
 * 项目绑定排第一，是因为目录只存在于那台机器上：在别处跑只会得到「目录不存在」。
 * 没绑定的项目目录在 Server 本机，所以默认先找 local Worker。
 */
export function placeSession(
  workers: readonly WorkerStatus[],
  request: PlacementRequest
): Result<string, DomainError> {
  const online = workers.filter((worker) => worker.state === 'online');
  const offers = (worker: WorkerStatus): boolean =>
    worker.agentIds === undefined || worker.agentIds.includes(request.agentId);
  const named = (id: string): WorkerStatus | undefined => workers.find((worker) => worker.workerId === id);

  // 没绑定的项目目录在 Server 本机：有和 Server 同机的 Worker 时，它就是这个项目的「家」。
  // 只有完全没有本机 Worker（HUB_SPAWN_WORKER=0、全靠远程）时，才允许点名别的机器。
  const home = request.projectWorker ?? workers.find((worker) => worker.origin === 'local')?.workerId ?? null;
  const pinned = home ?? request.requested;
  if (home !== null && request.requested !== null && request.requested !== home) {
    return err(conflict('这个项目的目录在另一台 Worker 上，会话只能在那台上跑'));
  }
  if (pinned !== null) {
    const worker = named(pinned);
    if (!worker || worker.state !== 'online') {
      return err(unavailable(`Worker「${worker?.label ?? pinned}」不在线`));
    }
    if (!offers(worker)) return err(conflict(`Worker「${worker.label}」没装 ${request.agentId}`));
    return ok(worker.workerId);
  }
  const candidate =
    online.find((worker) => worker.origin === 'local' && offers(worker)) ?? online.find(offers);
  if (!candidate) return err(unavailable(`没有在线的 Worker 提供 ${request.agentId}`));
  return ok(candidate.workerId);
}
