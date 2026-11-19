/**
 * 开会话 / 换模型能用的模型清单：hub 托管模型在前（hub-<slug>/<modelId>），再跟各机器上报的本地模型。
 */
import {
  canUseProvider,
  hubModelId,
  listProviders,
  type ModelProvider,
  type Principal,
  type ProviderDeps,
  type WorkerStatus
} from '@agent-hub/domain';

export interface SessionModelItem {
  readonly id: string;
  readonly source: 'hub' | 'worker';
  readonly provider?: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly routing: ModelProvider['routing'];
    readonly scope: ModelProvider['scope'];
    readonly protocol: ModelProvider['protocol'];
    readonly enabled: boolean;
  };
  readonly workerId?: string;
  readonly workerLabel?: string;
  readonly agentId?: string;
}

export async function listUsableHubModels(deps: ProviderDeps | undefined, actor: Principal): Promise<SessionModelItem[]> {
  if (!deps) return [];
  const out: SessionModelItem[] = [];
  for (const provider of await listProviders(deps, actor)) {
    if (!canUseProvider(actor, provider, null).ok) continue;
    for (const model of provider.models) {
      out.push({
        id: hubModelId(provider.slug, model.id),
        source: 'hub',
        provider: {
          id: provider.id,
          slug: provider.slug,
          name: provider.name,
          routing: provider.routing,
          scope: provider.scope,
          protocol: provider.protocol,
          enabled: provider.enabled
        }
      });
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export function workerLocalModels(
  workers: readonly WorkerStatus[],
  filter?: { readonly workerId?: string; readonly agentId?: string }
): SessionModelItem[] {
  const out: SessionModelItem[] = [];
  for (const worker of workers) {
    if (filter?.workerId && worker.workerId !== filter.workerId) continue;
    for (const entry of worker.agentModels ?? []) {
      if (filter?.agentId && entry.agentId !== filter.agentId) continue;
      for (const id of entry.models ?? []) {
        if (id.startsWith('hub-')) continue;
        out.push({
          id,
          source: 'worker',
          workerId: worker.workerId,
          workerLabel: worker.label,
          agentId: entry.agentId
        });
      }
    }
  }
  return out;
}

/** 把调用方能用的 hub 模型插到每个 agent 的 models 前面（按协议过滤，若机器报了 providers）。 */
export function attachHubModelsToWorker(worker: WorkerStatus, hub: readonly SessionModelItem[]): WorkerStatus {
  if (hub.length === 0 || !worker.agentModels?.length) return worker;
  return {
    ...worker,
    agentModels: worker.agentModels.map((entry) => {
      const allowed = entry.providers;
      const extra = hub
        .filter((model) => !allowed?.length || (model.provider !== undefined && allowed.includes(model.provider.protocol)))
        .map((model) => model.id)
        .filter((id) => !(entry.models ?? []).includes(id));
      return extra.length === 0 ? entry : { ...entry, models: [...extra, ...(entry.models ?? [])] };
    })
  };
}

export async function collectSessionModels(input: {
  readonly actor: Principal;
  readonly workers: readonly WorkerStatus[];
  readonly readable: (workerId: string) => boolean | Promise<boolean>;
  readonly providers?: ProviderDeps;
  readonly workerId?: string;
  readonly agentId?: string;
}): Promise<{ readonly hub: SessionModelItem[]; readonly workers: WorkerStatus[]; readonly models: SessionModelItem[] }> {
  const visible: WorkerStatus[] = [];
  for (const worker of input.workers) {
    if (await input.readable(worker.workerId)) visible.push(worker);
  }
  const hub = await listUsableHubModels(input.providers, input.actor);
  const local = workerLocalModels(visible, { workerId: input.workerId, agentId: input.agentId });
  const hubFiltered =
    input.workerId || input.agentId
      ? hub.filter((model) => {
          const worker = visible.find((item) => !input.workerId || item.workerId === input.workerId);
          if (!worker) return input.workerId ? false : true;
          if (!input.agentId) return true;
          const entry = worker.agentModels?.find((item) => item.agentId === input.agentId);
          if (!entry) return false;
          const allowed = entry.providers;
          return !allowed?.length || (model.provider !== undefined && allowed.includes(model.provider.protocol));
        })
      : hub;
  return { hub, workers: visible, models: [...hubFiltered, ...local] };
}
