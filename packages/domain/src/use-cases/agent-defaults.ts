import { agentDefaultsProblem, normalizeAgentDefaults, type RuntimeModelDefaults } from '../agent-defaults.ts';
import type { AgentDefaultsStore } from '../ports/agent-defaults.ts';
import type { Principal } from '../account.ts';
import { can } from '../access.ts';
import { err, ok, type Result } from '../result.ts';
import { forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import type { TeamDeps } from './team.ts';

/**
 * 团队级的运行时默认模型（界面：团队页 → 默认模型）。
 *
 * 读：团队里谁都能看（它决定新会话跑在哪个模型上，属于团队约定）；
 * 写：`team.manage`（owner / admin 或等价的自定义角色）。
 */
export type AgentDefaultsDeps = Pick<TeamDeps, 'teams'> & {
  readonly agentDefaults: AgentDefaultsStore;
};

async function teamOf(deps: AgentDefaultsDeps, principal: Principal) {
  const team = principal.user.teamId ? await deps.teams.byId(principal.user.teamId) : null;
  return team === null ? err(notFound('你还没有团队')) : ok(team);
}

export async function viewAgentDefaults(deps: AgentDefaultsDeps, principal: Principal): Promise<Result<RuntimeModelDefaults, DomainError>> {
  const team = await teamOf(deps, principal);
  if (!team.ok) return team;
  return ok(await deps.agentDefaults.forTeam(team.value.id));
}

export interface SetAgentDefaultsCommand {
  readonly defaults: unknown;
}

export async function setAgentDefaults(deps: AgentDefaultsDeps, principal: Principal, command: SetAgentDefaultsCommand): Promise<Result<RuntimeModelDefaults, DomainError>> {
  const team = await teamOf(deps, principal);
  if (!team.ok) return team;
  if (!can(principal, 'team.manage', { teamId: team.value.id })) return err(forbidden('只有团队 owner / admin 能改默认模型'));
  const problem = agentDefaultsProblem(command.defaults);
  if (problem !== null) return err(invalid(problem));
  const defaults = normalizeAgentDefaults(command.defaults);
  await deps.agentDefaults.save(team.value.id, defaults);
  return ok(defaults);
}
