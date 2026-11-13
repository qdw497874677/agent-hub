import type { Principal } from '../account.ts';
import { validateAgentRef } from '../agent-ref.ts';
import { botIdFrom, type Bot, type BotDefinition, type BotId } from '../bot.ts';
import { invalid, notFound, type DomainError } from '../errors.ts';
import type { ProjectId } from '../ids.ts';
import { configProblem, isPersistentAgentName, type MessagingConfig, type RoleReuse } from '../messaging.ts';
import type { RuntimeOption } from '../option.ts';
import type { MessageStore } from '../ports/message-store.ts';
import { err, ok, type Result } from '../result.ts';
import { authorizeProject, type AccessPolicy } from './authorization.ts';
import type { Deps } from './deps.ts';

/**
 * 一等 bot（C3a）：项目级、按条读写。
 *
 * - 读要 `project.read`，改要 `project.share`（与「管理项目成员」同级，bot 是项目的一等成员）；
 * - `name` 是 @id，建好不改：地址、群成员、spawn 记录、连接器都按它引用；
 * - 删除只删 bot 行，群里/会话里的引用不拦也不清（沿用今天的行为，由调用方决定是否 detach）。
 */
export interface BotInput {
  readonly name: string;
  readonly displayName?: string;
  readonly color?: string;
  readonly description?: string;
  readonly agentId: string;
  readonly model?: string;
  readonly reuse?: RoleReuse;
  readonly options?: Readonly<Record<string, string | boolean>>;
}

/** PATCH：除 name 外的字段；带上不同的 name 会被拒（建好不改）。 */
export type BotPatch = Partial<Omit<BotInput, 'name'>> & { readonly name?: string };

/** 回落到旧 roles JSON 只需要这两个端口。 */
export interface BotReadDeps extends Pick<Deps, 'bots'> {
  readonly messages: Pick<MessageStore, 'config'>;
}

export interface BotsDeps extends BotReadDeps, Pick<Deps, 'projects' | 'sessions' | 'now'> {
  readonly policy?: AccessPolicy;
}

const isBotNameProblem = (name: string): string | null =>
  isPersistentAgentName(name) ? null : '@id 只能用小写字母、数字、- 和 _，字母或数字开头（最多 40 个字符）';

/** 输入的扁平形状（HTTP body 保持 agentId/model/options）→ bot 定义。 */
function definitionOf(input: {
  readonly name: string;
  readonly displayName?: string;
  readonly color?: string;
  readonly description: string;
  readonly agentId: string;
  readonly model: string;
  readonly reuse: RoleReuse;
  readonly options?: Readonly<Record<string, string | boolean>>;
}): BotDefinition {
  const displayName = input.displayName?.trim();
  return {
    name: input.name.trim(),
    ...(displayName ? { displayName } : {}),
    ...(input.color ? { color: input.color } : {}),
    description: input.description,
    ref: {
      runtime: (input.agentId ?? '').trim(),
      model: (input.model ?? '').trim(),
      options: { ...(input.options ?? {}) }
    },
    reuse: input.reuse
  };
}

function shapeProblem(bot: BotDefinition): string | null {
  return configProblem({ roles: [bot], limits: {} });
}

/**
 * 这个项目里该 agent 上报过的可调项（按 id 去重，取自各会话的 `optionSpec`）。
 * agent 的静态 descriptor 只带 models，选项清单要等会话握手后才有，所以只能从已有会话里学。
 */
async function observedOptions(deps: Pick<Deps, 'sessions'>, projectId: ProjectId, agentId: string): Promise<readonly RuntimeOption[]> {
  const seen = new Map<string, RuntimeOption>();
  for (const session of await deps.sessions.listByProject(projectId)) {
    if (session.agentId !== agentId) continue;
    for (const option of session.optionSpec) if (!seen.has(option.id)) seen.set(option.id, option);
  }
  return [...seen.values()];
}

/** 拿这个 agent 上报过的可调项再校一遍 ref；runtime 为空时交给 configProblem 报更好懂的错。 */
async function refProblem(deps: Pick<Deps, 'sessions'>, projectId: ProjectId, bot: BotDefinition): Promise<string | null> {
  if (bot.ref.runtime === '') return null;
  const checked = validateAgentRef(bot.ref, await observedOptions(deps, projectId, bot.ref.runtime));
  return checked.ok ? null : checked.error.message;
}

/** 同一个 (projectId, name) 在迁移前后必须得到同一个 id，所以这里只用 name 作 seed。 */
const idFor = (projectId: ProjectId, name: string): BotId => botIdFrom(`${projectId}\0${name}`);

/** 旧 roles JSON → Bot。id 由 (projectId, name) 决定，迁移/C3b 落库时用同一个 seed。 */
export function botsFromLegacy(config: MessagingConfig | null, projectId: ProjectId): readonly Bot[] {
  if (!config || config.roles.length === 0) return [];
  return config.roles.map((role) => ({
    ...role,
    id: idFor(projectId, role.name),
    projectId,
    createdAt: config.updatedAt,
    updatedAt: config.updatedAt
  }));
}

export async function legacyBots(deps: BotReadDeps, projectId: ProjectId): Promise<readonly Bot[]> {
  return botsFromLegacy(await deps.messages.config(projectId), projectId);
}

/**
 * 读 bot 列表：bots 表为空时回落到旧的 roles JSON（只读、不写回）。
 *
 * ⚠ 过渡期兼容（C3b 迁移前）：部署顺序是「先上新代码、再迁移数据」，所以表为空时必须
 * 还能看见旧 bot。迁移脚本跑完后这段可以删掉；回落映射只在 `legacyBots()` 一处。
 */
export async function ensureBots(deps: BotReadDeps, projectId: ProjectId): Promise<readonly Bot[]> {
  const stored = await deps.bots.list(projectId);
  if (stored.length > 0) return stored;
  return legacyBots(deps, projectId);
}

/**
 * 改动前先把旧 roles JSON 落进 bots 表，避免「新建一条 → 表不再为空 → 旧 bot 从列表里消失」。
 * 只在表为空时有动作，是迁移前的懒补写；C3b 正式迁移后不会再有旧数据。
 */
async function adoptBots(deps: BotReadDeps, projectId: ProjectId): Promise<void> {
  const stored = await deps.bots.list(projectId);
  if (stored.length > 0) return;
  for (const bot of await legacyBots(deps, projectId)) await deps.bots.save(bot);
}

const authorize = async (deps: BotsDeps, actor: Principal | null, projectId: ProjectId, permission: 'project.read' | 'project.share') =>
  authorizeProject(deps.policy, actor, await deps.projects.byId(projectId), permission);

export async function listBotsUseCase(deps: BotsDeps, actor: Principal | null, projectId: ProjectId): Promise<Result<readonly Bot[], DomainError>> {
  const project = await authorize(deps, actor, projectId, 'project.read');
  if (!project.ok) return project;
  return ok(await ensureBots(deps, projectId));
}

export async function createBotUseCase(deps: BotsDeps, actor: Principal | null, projectId: ProjectId, input: BotInput): Promise<Result<Bot, DomainError>> {
  const project = await authorize(deps, actor, projectId, 'project.share');
  if (!project.ok) return project;
  const name = String(input.name ?? '').trim();
  const nameProblem = isBotNameProblem(name);
  if (nameProblem) return err(invalid(nameProblem));
  const existing = await ensureBots(deps, projectId);
  if (existing.some((bot) => bot.name === name)) return err(invalid(`@${name} 已经有了，换一个 @id`));
  const definition = definitionOf({
    name,
    displayName: input.displayName,
    color: input.color,
    description: input.description ?? '',
    agentId: input.agentId,
    model: input.model ?? '',
    reuse: input.reuse ?? 'sticky',
    ...(input.options !== undefined ? { options: input.options } : {})
  });
  const problem = shapeProblem(definition);
  if (problem) return err(invalid(problem));
  const specProblem = await refProblem(deps, projectId, definition);
  if (specProblem) return err(invalid(`bot ${name} 的${specProblem}`));
  const now = deps.now();
  // id 只由 (projectId, name) 决定：迁移脚本按同一 seed 生成，重建/重跑都不会换 id。
  const bot: Bot = { ...definition, id: idFor(projectId, name), projectId, createdAt: now, updatedAt: now };
  // 先补写旧数据，再插新 bot，避免旧 bot 被挡住。
  await adoptBots(deps, projectId);
  await deps.bots.save(bot);
  return ok(bot);
}

/**
 * 按 id 找 bot。bots 表里没有时，在旧 roles JSON 的回落里按确定的 id 找，
 * 找到就顺手把该项目旧 bot 补写进表（迁移前过渡；正式迁移后走不到这一步）。
 */
async function findBot(deps: BotsDeps, id: BotId): Promise<Bot | null> {
  const direct = await deps.bots.byId(id);
  if (direct) return direct;
  for (const project of await deps.projects.list()) {
    const fallback = await legacyBots(deps, project.id);
    if (!fallback.some((bot) => bot.id === id)) continue;
    await adoptBots(deps, project.id);
    const adopted = await deps.bots.byId(id);
    return adopted ?? fallback.find((bot) => bot.id === id) ?? null;
  }
  return null;
}

export async function getBotUseCase(deps: BotsDeps, actor: Principal | null, id: BotId): Promise<Result<Bot, DomainError>> {
  const current = await findBot(deps, id);
  if (!current) return err(notFound('没有这个 bot'));
  const project = await authorize(deps, actor, current.projectId, 'project.read');
  if (!project.ok) return project;
  return ok(current);
}

export async function updateBotUseCase(deps: BotsDeps, actor: Principal | null, id: BotId, patch: BotPatch): Promise<Result<Bot, DomainError>> {
  const current = await findBot(deps, id);
  if (!current) return err(notFound('没有这个 bot'));
  const project = await authorize(deps, actor, current.projectId, 'project.share');
  if (!project.ok) return project;
  if (patch.name !== undefined && patch.name.trim() !== current.name) return err(invalid('bot 的名字建好就不能改'));
  const definition = definitionOf({
    name: current.name,
    displayName: patch.displayName !== undefined ? patch.displayName : current.displayName,
    color: patch.color !== undefined ? patch.color : current.color,
    description: patch.description !== undefined ? patch.description : current.description,
    agentId: patch.agentId ?? current.ref.runtime,
    model: patch.model ?? current.ref.model,
    reuse: patch.reuse ?? current.reuse,
    options: patch.options ?? current.ref.options
  });
  const problem = shapeProblem(definition);
  if (problem) return err(invalid(problem));
  const specProblem = await refProblem(deps, current.projectId, definition);
  if (specProblem) return err(invalid(`bot ${current.name} 的${specProblem}`));
  const next: Bot = { ...current, ...definition, updatedAt: deps.now() };
  await deps.bots.save(next);
  return ok(next);
}

export async function removeBotUseCase(deps: BotsDeps, actor: Principal | null, id: BotId): Promise<Result<{ removed: true }, DomainError>> {
  const current = await findBot(deps, id);
  if (!current) return err(notFound('没有这个 bot'));
  const project = await authorize(deps, actor, current.projectId, 'project.share');
  if (!project.ok) return project;
  // 有会话 / 群引用也不拦：只删 bot 行，引用由上层决定怎么收尾（群聊会调 detachAgent）。
  await deps.bots.remove(current.id);
  return ok({ removed: true });
}

/**
 * 项目消息配置：bot 列表来自 bots 表（表空时回落旧 roles JSON），限额仍读旧的配置行。
 * 这是消息总线 `config()` 的唯一读路径，也是回落逻辑在用例层唯一的使用者。
 */
export async function loadBotConfig(deps: BotReadDeps, projectId: ProjectId): Promise<MessagingConfig> {
  const legacy = await deps.messages.config(projectId);
  const stored = await deps.bots.list(projectId);
  return {
    projectId,
    // 表为空 = 还没迁移：回落到旧 roles JSON（只读，不写回）。
    roles: stored.length > 0 ? stored : botsFromLegacy(legacy, projectId),
    limits: legacy?.limits ?? {},
    updatedAt: legacy?.updatedAt ?? 0
  };
}
