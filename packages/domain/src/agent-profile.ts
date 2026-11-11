import type { AgentId } from './ids.ts';
import { asAgentId, newId } from './ids.ts';
import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/** Agent Profile：一组可复用的会话启动配置，归属到人（没装账号时 ownerId = null）。 */
export interface AgentProfile {
  readonly id: string;
  readonly ownerId: string | null;
  readonly name: string;
  readonly agentId: AgentId;
  readonly model: string;
  readonly options: Readonly<Record<string, string | boolean>>;
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

function cleanOptions(input: Readonly<Record<string, string | boolean>> | undefined): Result<Record<string, string | boolean>, DomainError> {
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    const id = key.trim();
    if (id === '' || id.length > 200) return err(invalid('Agent 配置里有一个选项名不合法'));
    if (typeof value !== 'string' && typeof value !== 'boolean') return err(invalid(`Agent 配置里的 ${id} 只能是字符串或开关`));
    if (typeof value === 'string' && value.length > 2000) return err(invalid(`Agent 配置里的 ${id} 太长了`));
    out[id] = value;
  }
  return ok(out);
}

export function validateAgentProfile(input: AgentProfileInput): Result<{
  name: string;
  agentId: AgentId;
  model: string;
  options: Record<string, string | boolean>;
  notes: string;
}, DomainError> {
  const name = input.name.trim();
  if (name === '') return err(invalid('Agent 配置的名字不能为空'));
  if (name.length > AGENT_PROFILE_NAME_MAX) return err(invalid('Agent 配置的名字太长了'));
  const agentId = input.agentId.trim();
  if (agentId === '') return err(invalid('Agent 配置必须指定一个 agent'));
  const model = (input.model ?? '').trim();
  if (model.length > 2000) return err(invalid('模型名太长了'));
  const notes = (input.notes ?? '').trim();
  if (notes.length > AGENT_PROFILE_NOTES_MAX) return err(invalid('备注太长了'));
  const options = cleanOptions(input.options);
  if (!options.ok) return options;
  return ok({ name, agentId: asAgentId(agentId), model, options: options.value, notes });
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
    agentId: valid.value.agentId,
    model: valid.value.model,
    options: valid.value.options,
    notes: valid.value.notes,
    createdAt: now,
    updatedAt: now
  });
}
