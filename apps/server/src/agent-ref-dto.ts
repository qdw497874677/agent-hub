import type { AgentProfile, AgentRef, Bot, MessagingConfig, PersistentAgent } from '@agent-hub/domain';

/**
 * HTTP / DTO 边界：domain 内部统一用 `ref`，对外的 JSON 仍是老的扁平形状
 * （`agentId` / `model` / `options`），这样前端与既有 e2e 不用跟着改。
 * 想切到 `ref` 时只改这里，不动业务代码。
 */
const refDto = (ref: AgentRef): { agentId: string; model: string; options?: Readonly<Record<string, string | boolean>> } => ({
  agentId: ref.runtime,
  model: ref.model,
  ...(Object.keys(ref.options).length > 0 ? { options: ref.options } : {})
});

export const agentProfileDto = (profile: AgentProfile) => ({
  id: profile.id,
  ownerId: profile.ownerId,
  name: profile.name,
  agentId: profile.ref.runtime,
  model: profile.ref.model,
  options: profile.ref.options,
  notes: profile.notes,
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt
});

export const botDto = (agent: PersistentAgent) => {
  const { ref, ...rest } = agent;
  return { ...rest, ...refDto(ref) };
};

/** `/api/bots` 的一条：扁平 ref + id / projectId / 时间戳（contract 的 BotRecordDto）。 */
export const botRecordDto = (bot: Bot) => ({
  id: bot.id,
  projectId: bot.projectId,
  name: bot.name,
  ...refDto(bot.ref),
  displayName: bot.displayName,
  color: bot.color,
  description: bot.description,
  reuse: bot.reuse,
  createdAt: bot.createdAt,
  updatedAt: bot.updatedAt
});

export const messagingConfigDto = (config: MessagingConfig) => ({ ...config, roles: config.roles.map(botDto) });
