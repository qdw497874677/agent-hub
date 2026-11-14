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

/** 「开始」为什么点不了。派生对话框底部的说明行直接念它；能用时返回 null（那行不渲染）。 */
export interface StartHintInput {
  readonly agentId: string;
  readonly agentLabel: string;
  /** 选中的机器；null = 还没选。 */
  readonly machine: string | null;
  readonly worker: GateWorker | undefined;
  readonly model: string;
  readonly protocol: string | null;
  /** choiceReady 的结果。 */
  readonly workspaceReady: boolean;
  /** 选了「新建持久工作空间」但还没挑目录。 */
  readonly workspaceNeedsPath?: boolean;
}

/**
 * 按人头先说最挡路的那个：机器 → agent → 这台机器上的运行时 → 工作空间。
 * 一句人话，不重复按钮上的灰，也不把原因藏在 title 里（手机上根本没有 hover）。
 */
export function startHint(input: StartHintInput): string | null {
  if (input.machine === null) return '先选一台机器';
  if (input.agentId.trim() === '') return '先选一个 agent';
  const reason = startBlockReason(input.worker, input.agentId, input.model, input.protocol);
  if (reason !== null) {
    const label = input.agentLabel.trim() === '' ? input.agentId : input.agentLabel.trim();
    return reason.trim() === '' ? `这台机器上的 ${label} 用不了` : `这台机器上的 ${label} 用不了：${reason.trim()}`;
  }
  if (!input.workspaceReady) return input.workspaceNeedsPath === true ? '先选一个目录' : '先选一个工作空间';
  return null;
}
