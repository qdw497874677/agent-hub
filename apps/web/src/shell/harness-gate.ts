/** 派生对话框用的最小机器形状，避免把 React 组件引进纯函数。 */
export interface GateWorker {
  /** 在线状态；老调用方不传时按在线处理（只看 harness 原因）。 */
  readonly state?: string;
  /** 这台机器上装了哪些 agent；老 Worker 不报时，调用方仍按「有这个 agent」处理。 */
  readonly agentIds?: readonly string[];
  readonly agentModels?: readonly {
    readonly agentId: string;
    readonly providers?: readonly string[];
    readonly readiness?: { readonly state: string; readonly reason?: string };
  }[];
}

/** 这台机器是否装着当前 agent。老 Worker 不报 agentIds 时沿用「不拦」的旧行为。 */
export function workerOffersAgent(worker: GateWorker | undefined, agentId: string): boolean {
  if (worker === undefined || agentId.trim() === '') return false;
  return (worker.agentIds ?? [agentId]).includes(agentId);
}

/**
 * 和 WorkspaceChooser 共用的「这台机器现在能不能选」：
 * 在线、装着当前 agent、harness 可用（或「未配置模型」但已有同协议 Hub 模型）。
 * 选择器的格子、空态分类、底部说明都走这一条，避免三处各判各的。
 */
export function machineSelectable(worker: GateWorker | undefined, agentId: string, hubProtocols: readonly string[]): boolean {
  if (worker === undefined || worker.state !== 'online' || !workerOffersAgent(worker, agentId)) return false;
  return canSelectMachine(worker, agentId, hubProtocols);
}

export type MachineAvailability =
  /** 机器列表还没读到（加载中或查询失败），先别下「没有机器」的结论。 */
  | { readonly kind: 'unknown'; readonly loading: boolean; readonly failed: boolean }
  /** 还没有可选的 agent（画布里没有 agent），不是「机器全离线」。 */
  | { readonly kind: 'no-agent' }
  | { readonly kind: 'no-machines' }
  | { readonly kind: 'all-offline'; readonly total: number }
  /** 有在线机器，但没有一台能跑当前 agent：没装和装坏了分开计数，文案才能说准。 */
  | { readonly kind: 'agent-unavailable'; readonly online: number; readonly blocked: number; readonly missing: number }
  | { readonly kind: 'available'; readonly usable: number; readonly blocked: number };

/**
 * 把「机器列表 + 当前 agent」归成一句能说清的状态。
 * `loading` / `failed` 只在列表为空时使用：有旧数据时照旧按旧数据判断，不把短暂刷新说成不可用。
 */
export function machineAvailability(
  workers: readonly GateWorker[],
  agentId: string,
  hubProtocols: readonly string[],
  state: { readonly loading?: boolean; readonly failed?: boolean } = {}
): MachineAvailability {
  if (workers.length === 0) {
    if (state.loading === true) return { kind: 'unknown', loading: true, failed: false };
    if (state.failed === true) return { kind: 'unknown', loading: false, failed: true };
    return { kind: 'no-machines' };
  }
  if (agentId.trim() === '') return { kind: 'no-agent' };
  const online = workers.filter((worker) => worker.state === 'online');
  if (online.length === 0) return { kind: 'all-offline', total: workers.length };
  const missing = online.filter((worker) => !workerOffersAgent(worker, agentId)).length;
  const blocked = online.filter(
    (worker) => workerOffersAgent(worker, agentId) && !machineSelectable(worker, agentId, hubProtocols)
  ).length;
  const usable = online.filter((worker) => machineSelectable(worker, agentId, hubProtocols)).length;
  if (usable > 0) return { kind: 'available', usable, blocked };
  return { kind: 'agent-unavailable', online: online.length, blocked, missing };
}

/** 底部说明行用的短句；null = 没有机器层面的阻塞。 */
export function machineAvailabilityHint(
  machines: MachineAvailability | undefined,
  agentLabel: string
): string | null {
  if (machines === undefined) return null;
  const label = agentLabel.trim() === '' ? '这个 agent' : agentLabel.trim();
  switch (machines.kind) {
    case 'unknown':
      return machines.loading ? '正在读取机器状态…' : '机器状态没读到，重新检查后再试';
    case 'no-agent':
      return '还没有可用的 agent';
    case 'no-machines':
      return '先在「机器」里接入一台机器';
    case 'all-offline':
      return '先让一台机器上线';
    case 'agent-unavailable':
      if (machines.missing > 0 && machines.blocked > 0) return `在线的机器上有的没装 ${label}，有的用不了，换一个 agent`;
      if (machines.missing > 0) return `在线的机器都没有 ${label}，换一个 agent`;
      return `在线的机器上 ${label} 用不了，换一个 agent 或先修好它`;
    case 'available':
      return null;
  }
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
  // 机器不在线：agent 的探测结果可能是上一次留下的，不能拿它当「能开」。
  if (worker?.state === 'offline') return '机器不在线';
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
 * 会话里记下的模型如果是 Hub 模型，它在清单里属于哪个协议。
 * 「换个地方继续」会原样带上这条会话的模型，所以判断目标机器能不能接着跑时要用这个协议，
 * 而不是像派生对话框那样另选一个 Hub 模型。不是 Hub 模型（或清单还没到）→ null。
 */
export function carriedProtocol(
  model: string,
  providers: readonly { readonly protocol: string; readonly models: readonly { readonly id: string }[] }[]
): string | null {
  if (model.trim() === '') return null;
  return providers.find((provider) => provider.models.some((item) => item.id === model))?.protocol ?? null;
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
  /** 机器列表的分类结果；传了之后，没得选时不再一律说「先选一台机器」。 */
  readonly machines?: MachineAvailability;
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
  // 机器列表还没读到：先说实话，别把「加载中」说成「没有机器」或「先选一台」。
  if (input.machines?.kind === 'unknown') return machineAvailabilityHint(input.machines, input.agentLabel);
  if (input.machine === null) {
    // 没得选时（全离线 / 当前 agent 在所有在线机器都不可用）给恢复方向；
    // 只有确实还有可选项时才说「先选一台机器」。
    return machineAvailabilityHint(input.machines, input.agentLabel) ?? '先选一台机器';
  }
  if (input.agentId.trim() === '') return '先选一个 agent';
  if (input.worker === undefined) {
    const machinesHint = machineAvailabilityHint(input.machines, input.agentLabel);
    if (machinesHint !== null) return machinesHint;
    // 没传机器列表的老调用方：沿用「拿不到 worker 就不额外拦」的旧行为。
    if (input.machines !== undefined) return '这台机器不在列表里了，重新选一台';
  }
  if (input.worker !== undefined && !workerOffersAgent(input.worker, input.agentId)) {
    const label = input.agentLabel.trim() === '' ? input.agentId : input.agentLabel.trim();
    return `这台机器没有 ${label}，换一台机器或换一个 agent`;
  }
  const reason = startBlockReason(input.worker, input.agentId, input.model, input.protocol);
  // 只差一个模型：说「去选模型」，别说「用不了」——模型框里就有能选的 hub 模型
  if (reason === '未配置模型' && input.model === '' && input.hubAvailable === true) return '先在「模型」里选一个 Hub 模型';
  if (reason !== null) {
    if (reason === '机器不在线') return '这台机器不在线';
    const label = input.agentLabel.trim() === '' ? input.agentId : input.agentLabel.trim();
    return reason.trim() === '' ? `这台机器上的 ${label} 用不了` : `这台机器上的 ${label} 用不了：${reason.trim()}`;
  }
  if (!input.workspaceReady) return input.workspaceNeedsPath === true ? '先选一个目录' : '先选一个工作目录';
  return null;
}
