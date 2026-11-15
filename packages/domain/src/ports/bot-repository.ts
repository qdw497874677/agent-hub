import type { Bot, BotId } from '../bot.ts';
import type { BotGrant } from '../bot-grant.ts';
import type { ProjectId } from '../ids.ts';

/**
 * bot 的读写端口。bot 是团队级实体（`teamId`），进哪个项目看 `BotGrant`。
 *
 * 老实现按项目存（`list(projectId)` / `byName(projectId, name)`）；迁移后这两个方法保留同一个
 * 形状但语义换成「经由授权过滤」——调用点不用一次性全改，读路径仍然按项目找得到。
 */
export interface BotRepository {
  byId(id: BotId): Promise<Bot | null>;
  /** 团队内按 @id 找（名字在团队内唯一）。 */
  byName(teamId: string, name: string): Promise<Bot | null>;
  /** 团队里的全部 bot，按创建顺序（created_at，再按 name）。 */
  listByTeam(teamId: string): Promise<readonly Bot[]>;
  /** 已授权到该项目、且仍在役的 bot。群/消息配置用这个。 */
  listForProject(projectId: ProjectId): Promise<readonly Bot[]>;
  save(bot: Bot): Promise<void>;
  remove(id: BotId): Promise<void>;

  /** 这个 bot 的全部授权，按 createdAt。 */
  grantsOf(botId: BotId): Promise<readonly BotGrant[]>;
  /** 某个项目的全部授权（管理员视角）。 */
  grantsForProject(projectId: ProjectId): Promise<readonly BotGrant[]>;
  grant(grant: BotGrant): Promise<void>;
  revoke(botId: BotId, projectId: ProjectId): Promise<void>;
}
