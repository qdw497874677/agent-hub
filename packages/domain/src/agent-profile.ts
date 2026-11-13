import { newId } from './ids.ts';
import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';
import { validateAgentRef, type AgentRef } from './agent-ref.ts';

/** Agent Profile：一组可复用的会话启动配置，归属到人（没装账号时 ownerId = null）。 */
export interface AgentProfile {
  readonly id: string;
  readonly ownerId: string | null;
  readonly name: string;
  /** runtime + model + options 三件套，与会话 / bot 用同一个形状。 */
  readonly ref: AgentRef;
  readonly notes: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgentProfileInput {
  readonly name: string;
  readonly agentId: string;
  readonly model?: string;
  readonly options?: Readonly<Record<string, string | boolean>>;
  readonly notes?: string;
}

export const AGENT_PROFILE_NAME_MAX = 80;
export const AGENT_PROFILE_NOTES_MAX = 2000;

export function validateAgentProfile(input: AgentProfileInput): Result<{
  name: string;
  ref: AgentRef;
  notes: string;
}, DomainError> {
  const name = input.name.trim();
  if (name === '') return err(invalid('Agent 配置的名字不能为空'));
  if (name.length > AGENT_PROFILE_NAME_MAX) return err(invalid('Agent 配置的名字太长了'));
  const ref = validateAgentRef({ runtime: input.agentId, model: input.model, options: input.options });
  if (!ref.ok) return ref;
  const notes = (input.notes ?? '').trim();
  if (notes.length > AGENT_PROFILE_NOTES_MAX) return err(invalid('备注太长了'));
  return ok({ name, ref: ref.value, notes });
}

export function newAgentProfile(
  input: AgentProfileInput,
  ownerId: string | null,
  now: number
): Result<AgentProfile, DomainError> {
  const valid = validateAgentProfile(input);
  if (!valid.ok) return valid;
  return ok({
    id: newId(),
    ownerId,
    name: valid.value.name,
    ref: valid.value.ref,
    notes: valid.value.notes,
    createdAt: now,
    updatedAt: now
  });
}
