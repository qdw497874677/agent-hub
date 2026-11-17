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
 * 没配原生模型时，只要这台机器的 agent 报了协议，并且已经有同协议的 hub 模型，就可以先选机器和工作目录。
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

/** 「未配置模型」但这台机器上有同协议的 hub 模型能顶上：不算坏，只是要先选一个 hub 模型。 */
export function hubCovers(worker: GateWorker | undefined, agentId: string, hubProtocols: readonly string[]): boolean {
  return harnessReasonOf(worker, agentId) === '未配置模型' && canSelectMachine(worker, agentId, hubProtocols);
}

/**
 * agent 下拉里跟在名字后面的括注。hub 模型能顶上时不再写「未配置模型」——
 * 右边模型框里明明有可选的 hub 模型，左边还写「未配置」，两句话互相打架。
 */
export function agentNote(reason: string | null, covered: boolean): string | null {
  if (reason === null || reason.trim() === '') return null;
  if (reason === '未配置模型' && covered) return '选 Hub 模型';
  return reason;
}

/**
 * 模型下拉里「空值」那一项的文字；null = 不需要空值项（当前值就在清单里）。
 *
 * 受控 select 的 value 不在选项里时，浏览器会把第一项画成「已选中」，可状态里其实是空的：
 * 看着选好了，「开始」却是灰的。所以只要状态是空，就显式渲染一项空值，让看到的和状态一致。
 * - 机器上没有原生模型、只能用 hub 模型（needsChoice）：「选择模型…」，不替人默认选 hub 模型（a85a28d 的约定）。
 * - 其他情况：空值就是「用 agent 自己的默认」，照实写。
 */
export function emptyModelOption(models: readonly string[], model: string, needsChoice: boolean): string | null {
  // 非空值不在清单里的情况交给换机器时的那次重置（dialogs.tsx 的 offeredKey effect），这里只管空值
  if (model !== '') return null;
  return needsChoice && models.length > 0 ? '选择模型…' : '用 agent 自己的默认';
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
  /** 选了「新建持久工作目录」但还没挑目录。 */
  readonly workspaceNeedsPath?: boolean;
  /** 这台机器上有同协议的 hub 模型能顶上「未配置模型」（hubCovers）。 */
  readonly hubAvailable?: boolean;
}

/**
 * 按人头先说最挡路的那个：机器 → agent → 这台机器上的运行时 → 工作目录。
 * 一句人话，不重复按钮上的灰，也不把原因藏在 title 里（手机上根本没有 hover）。
 */
export function startHint(input: StartHintInput): string | null {
  if (input.machine === null) return '先选一台机器';
  if (input.agentId.trim() === '') return '先选一个 agent';
  const reason = startBlockReason(input.worker, input.agentId, input.model, input.protocol);
  // 只差一个模型：说「去选模型」，别说「用不了」——模型框里就有能选的 hub 模型
  if (reason === '未配置模型' && input.model === '' && input.hubAvailable === true) return '先在「模型」里选一个 Hub 模型';
  if (reason !== null) {
    const label = input.agentLabel.trim() === '' ? input.agentId : input.agentLabel.trim();
    return reason.trim() === '' ? `这台机器上的 ${label} 用不了` : `这台机器上的 ${label} 用不了：${reason.trim()}`;
  }
  if (!input.workspaceReady) return input.workspaceNeedsPath === true ? '先选一个目录' : '先选一个工作目录';
  return null;
}
