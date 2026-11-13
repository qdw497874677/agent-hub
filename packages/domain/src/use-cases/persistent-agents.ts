import type { Principal } from '../account.ts';
import type { Bot } from '../bot.ts';
import { notFound, type DomainError } from '../errors.ts';
import type { ProjectId } from '../ids.ts';
import type { RoleReuse } from '../messaging.ts';
import type { Group } from '../groups.ts';
import { err, ok, type Result } from '../result.ts';
import { createBotUseCase, listBotsUseCase, removeBotUseCase, updateBotUseCase, type BotPatch, type BotsDeps } from './bots.ts';

/**
 * 持久智能体（界面上叫「bot」）的按条读写 API —— 老名字，保留给 HTTP 路由与群聊用。
 *
 * C3a 起 bot 存在 `bots` 表（按条读写，避免整表覆盖）；这里只是 `use-cases/bots.ts`
 * 的适配层：把「按 name」换成「按 id」，删除后顺手把它从项目里所有群移出。
 * 读要 project.read，改要 project.share；地址仍叫 `role:<name>`（C3b 再改）。
 */
export interface PersistentAgentInput {
  readonly name: string;
  readonly displayName?: string;
  readonly color?: string;
  readonly description?: string;
  readonly agentId: string;
  readonly model?: string;
  readonly reuse?: RoleReuse;
  readonly options?: Readonly<Record<string, string | boolean>>;
}
export type PersistentAgentPatch = Partial<Omit<PersistentAgentInput, 'name'>>;

export interface PersistentAgentView extends Bot {
  /** 引用它的群（id + 名字）。 */
  readonly groups: readonly { id: string; name: string; host: boolean }[];
}

export interface PersistentAgentsDeps extends BotsDeps {
  readonly groupsOf: (projectId: ProjectId) => Promise<readonly Group[]>;
  readonly detach: (actor: Principal, projectId: ProjectId, name: string) => Promise<readonly Group[]>;
}

export interface PersistentAgents {
  list(actor: Principal, projectId: ProjectId): Promise<Result<readonly PersistentAgentView[], DomainError>>;
  create(actor: Principal, projectId: ProjectId, input: PersistentAgentInput): Promise<Result<Bot, DomainError>>;
  update(actor: Principal, projectId: ProjectId, name: string, patch: PersistentAgentPatch): Promise<Result<Bot, DomainError>>;
  remove(actor: Principal, projectId: ProjectId, name: string): Promise<Result<{ removedFrom: readonly { id: string; name: string }[] }, DomainError>>;
}

export function createPersistentAgents(deps: PersistentAgentsDeps): PersistentAgents {
  const locate = async (actor: Principal, projectId: ProjectId, name: string): Promise<Result<Bot, DomainError>> => {
    const bots = await listBotsUseCase(deps, actor, projectId);
    if (!bots.ok) return bots;
    const found = bots.value.find((bot) => bot.name === name);
    return found ? ok(found) : err(notFound(`没有 bot @${name}`));
  };

  return {
    async list(actor, projectId) {
      const bots = await listBotsUseCase(deps, actor, projectId);
      if (!bots.ok) return bots;
      const groups = await deps.groupsOf(projectId);
      return ok(
        bots.value.map((bot) => ({
          ...bot,
          groups: groups.filter((g) => g.members.includes(bot.name) || g.hostRole === bot.name).map((g) => ({ id: g.id, name: g.name, host: g.hostRole === bot.name }))
        }))
      );
    },

    async create(actor, projectId, input) {
      return createBotUseCase(deps, actor, projectId, input);
    },

    async update(actor, projectId, name, patch) {
      const current = await locate(actor, projectId, name);
      if (!current.ok) return current;
      const next: BotPatch = patch;
      return updateBotUseCase(deps, actor, current.value.id, next);
    },

    async remove(actor, projectId, name) {
      const current = await locate(actor, projectId, name);
      if (!current.ok) return current;
      const removed = await removeBotUseCase(deps, actor, current.value.id);
      if (!removed.ok) return removed;
      // bot 行删掉后再从群里移出（群聊用例负责串行与系统消息）；有会话引用不拦。
      const affected = await deps.detach(actor, projectId, name);
      return ok({ removedFrom: affected.map((g) => ({ id: g.id, name: g.name })) });
    }
  };
}
