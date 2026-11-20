import type { AgentAliasDto } from '../../surfaces/workbench/agent-aliases.ts';
import { call } from './http.ts';

export type { WorkerInfoDto } from '@agent-hub/contract';
/**
 * 一台机器的运行时别名（ACP agent 声明，`ACP_AGENTS` 的界面版）。
 * owner 能改；admin 只能看。保存后 hub 推给在线 worker，只对之后新建的会话生效。
 * 形状先声明在 web 内的纯逻辑模块里（要和它一起被根 tsconfig 编译），等 contract 落定再换过去。
 */
export type { AgentAliasDto } from '../../surfaces/workbench/agent-aliases.ts';

/** 接入码预设（ADR 0030）：readonly 只读机器、no-remote 不允许远程仓库、no-install 不允许装组件。 */
export type WorkerPreset = 'full' | 'readonly' | 'no-remote' | 'no-install';

export const workerApi = {
  agents: (workerId: string) => call<{ aliases: AgentAliasDto[] }>(`/api/workers/${encodeURIComponent(workerId)}/agents`),
  saveAgents: (workerId: string, aliases: AgentAliasDto[]) =>
    call<{ aliases: AgentAliasDto[] }>(`/api/workers/${encodeURIComponent(workerId)}/agents`, { method: 'PUT', body: JSON.stringify({ aliases }) })
};
