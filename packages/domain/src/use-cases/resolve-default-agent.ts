import type { AgentRef } from '../agent-ref.ts';
import type { RuntimeModelDefaults } from '../agent-defaults.ts';
import type { Project } from '../project.ts';
import type { Task } from '../task.ts';
import type { AgentDefaultsStore } from '../ports/agent-defaults.ts';

/**
 * 新会话没显式点名时，默认 Agent 从哪一层来的。
 * runtime 不会来自团队（团队只补模型）；model 可以来自团队按运行时的默认表。
 */
export type DefaultAgentSource = 'explicit' | 'task' | 'project' | 'team' | 'unset';

export interface ResolvedDefaultAgent {
  readonly effective: AgentRef;
  readonly layers: {
    readonly project: AgentRef | null;
    readonly task: AgentRef | null;
    readonly teamDefaults: RuntimeModelDefaults;
    readonly teamModel: string | null;
  };
  readonly sources: {
    readonly runtime: Exclude<DefaultAgentSource, 'team'>;
    readonly model: DefaultAgentSource;
  };
}

/**
 * 默认 Agent 的层级（从低到高）：团队按运行时的默认模型 < 项目默认 < 任务默认 < 显式选择。
 *
 * runtime 只有完全没说时才由任务 / 项目补（任务优先）；模型按层从高到低取第一个非空
 * （只看与已定 runtime 相同的层）；选项逐层铺开、上层覆盖下层；团队默认模型只在模型仍为空时补。
 */
export function applyDefaultAgentLayers(input: {
  readonly project: AgentRef | null;
  readonly task: AgentRef | null;
  readonly teamDefaults: RuntimeModelDefaults;
  readonly explicit: AgentRef;
}): ResolvedDefaultAgent {
  let ref: AgentRef = {
    runtime: input.explicit.runtime,
    model: input.explicit.model,
    options: { ...input.explicit.options }
  };
  let runtimeSource: ResolvedDefaultAgent['sources']['runtime'] = ref.runtime !== '' ? 'explicit' : 'unset';
  let modelSource: DefaultAgentSource = ref.model !== '' ? 'explicit' : 'unset';

  const layers = [input.project, input.task].filter((layer): layer is AgentRef => layer !== null);

  if (ref.runtime === '') {
    for (const layer of [...layers].reverse()) {
      if (layer.runtime !== '') {
        ref = { ...ref, runtime: layer.runtime };
        runtimeSource = layer === input.task ? 'task' : 'project';
        break;
      }
    }
  }

  const sameRuntime = layers.filter((layer) => layer.runtime === ref.runtime);
  if (ref.model === '') {
    for (const layer of [...sameRuntime].reverse()) {
      if (layer.model !== '') {
        ref = { ...ref, model: layer.model };
        modelSource = layer === input.task ? 'task' : 'project';
        break;
      }
    }
  }
  if (sameRuntime.length > 0) {
    ref = {
      ...ref,
      options: { ...sameRuntime.reduce((merged, layer) => ({ ...merged, ...layer.options }), {}), ...ref.options }
    };
  }

  const teamModel = ref.runtime !== '' ? (input.teamDefaults[ref.runtime] ?? null) : null;
  if (ref.model === '' && teamModel !== null) {
    ref = { ...ref, model: teamModel };
    modelSource = 'team';
  }

  return {
    effective: ref,
    layers: {
      project: input.project,
      task: input.task,
      teamDefaults: input.teamDefaults,
      teamModel
    },
    sources: { runtime: runtimeSource, model: modelSource }
  };
}

/** 读项目 / 任务已落库的默认，再套上团队默认模型表。不要求该 runtime 当前在线。 */
export async function resolveDefaultAgent(
  deps: { readonly agentDefaults?: AgentDefaultsStore },
  input: { readonly project: Project; readonly task?: Task | null; readonly explicit?: Partial<AgentRef> }
): Promise<ResolvedDefaultAgent> {
  const teamDefaults =
    deps.agentDefaults && input.project.teamId ? await deps.agentDefaults.forTeam(input.project.teamId) : {};
  return applyDefaultAgentLayers({
    project: input.project.defaultAgent ?? null,
    task: input.task?.defaultAgent ?? null,
    teamDefaults,
    explicit: {
      runtime: input.explicit?.runtime ?? '',
      model: input.explicit?.model ?? '',
      options: { ...(input.explicit?.options ?? {}) }
    }
  });
}
