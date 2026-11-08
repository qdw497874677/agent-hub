/** 派生对话框用的最小机器形状，避免把 React 组件引进纯函数。 */
export interface GateWorker {
  readonly agentModels?: readonly {
    readonly agentId: string;
    readonly providers?: readonly string[];
    readonly readiness?: { readonly state: string; readonly reason?: string };
  }[];
}

export function harnessReasonOf(worker: GateWorker | undefined, agentId: string): string | null {
  const readiness = worker?.agentModels?.find((entry) => entry.agentId === agentId)?.readiness;
  return readiness?.state === 'unavailable' ? (readiness.reason ?? '') : null;
}

function protocolsOf(worker: GateWorker | undefined, agentId: string): readonly string[] {
  return worker?.agentModels?.find((entry) => entry.agentId === agentId)?.providers ?? [];
}

/**
 * 没配原生模型时，只要这台机器的 agent 报了协议，并且已经有同协议的 hub 模型，就可以先选机器和工作空间。
 * 不把空模型改成 hub 默认：没选模型时「开始」仍然不可用。
 * 未安装、检测失败等其他原因照旧不能选。
 */
export function canSelectMachine(worker: GateWorker | undefined, agentId: string, hubProtocols: readonly string[]): boolean {
  const reason = harnessReasonOf(worker, agentId);
  if (reason === null) return true;
  if (reason !== '未配置模型') return false;
  const protocols = protocolsOf(worker, agentId);
  return hubProtocols.some((protocol) => protocols.includes(protocol));
}

/** 选了同协议的 hub 模型之后，「未配置模型」不再挡住开始。空模型和其他原因仍挡住。 */
export function startBlockReason(worker: GateWorker | undefined, agentId: string, model: string, protocol: string | null): string | null {
  const reason = harnessReasonOf(worker, agentId);
  if (reason !== '未配置模型') return reason;
  if (!protocol || !/^hub-[a-z0-9][a-z0-9-]{0,30}\/\S+$/.test(model)) return reason;
  if (!protocolsOf(worker, agentId).includes(protocol)) return reason;
  return null;
}
