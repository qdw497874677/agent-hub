import type { AgentProfile, AgentProfileInput } from '../agent-profile.ts';
import { newAgentProfile, validateAgentProfile } from '../agent-profile.ts';
import { forbidden, notImplemented, notFound, type DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Deps } from './deps.ts';

type ProfileDeps = Pick<Deps, 'now'> & { readonly agentProfiles?: Deps['agentProfiles'] };

function store(deps: ProfileDeps): NonNullable<Deps['agentProfiles']> | null {
  return deps.agentProfiles ?? null;
}

export async function listAgentProfiles(deps: ProfileDeps, ownerId: string | null): Promise<Result<AgentProfile[], DomainError>> {
  const repo = store(deps);
  if (!repo) return ok([]);
  return ok(await repo.listByOwner(ownerId));
}

export async function createAgentProfile(
  deps: ProfileDeps,
  ownerId: string | null,
  input: AgentProfileInput
): Promise<Result<AgentProfile, DomainError>> {
  const repo = store(deps);
  if (!repo) return err(notImplemented('Agent 配置'));
  const created = newAgentProfile(input, ownerId, deps.now());
  if (!created.ok) return created;
  await repo.save(created.value);
  return created;
}

export async function updateAgentProfile(
  deps: ProfileDeps,
  ownerId: string | null,
  id: string,
  input: AgentProfileInput
): Promise<Result<AgentProfile, DomainError>> {
  const repo = store(deps);
  if (!repo) return err(notImplemented('Agent 配置'));
  const current = await repo.byId(id);
  if (!current) return err(notFound('没有这个 Agent 配置'));
  if (current.ownerId !== ownerId) return err(forbidden('无权改这个 Agent 配置'));
  const valid = validateAgentProfile(input);
  if (!valid.ok) return valid;
  const next: AgentProfile = {
    ...current,
    name: valid.value.name,
    ref: valid.value.ref,
    notes: valid.value.notes,
    updatedAt: deps.now()
  };
  await repo.save(next);
  return ok(next);
}

export async function deleteAgentProfile(deps: ProfileDeps, ownerId: string | null, id: string): Promise<Result<void, DomainError>> {
  const repo = store(deps);
  if (!repo) return err(notImplemented('Agent 配置'));
  const current = await repo.byId(id);
  if (!current) return err(notFound('没有这个 Agent 配置'));
  if (current.ownerId !== ownerId) return err(forbidden('无权删这个 Agent 配置'));
  await repo.remove(id);
  return ok(undefined);
}

/** 派生时取一份 profile；只允许用自己名下的。 */
export async function agentProfileForUse(
  deps: ProfileDeps,
  ownerId: string | null,
  id: string
): Promise<Result<AgentProfile, DomainError>> {
  const repo = store(deps);
  if (!repo) return err(notImplemented('Agent 配置'));
  const profile = await repo.byId(id);
  if (!profile) return err(notFound('没有这个 Agent 配置'));
  if (profile.ownerId !== ownerId) return err(forbidden('不能使用别人的 Agent 配置'));
  return ok(profile);
}
