import type { Bot, BotId } from '../bot.ts';
import type { ProjectId } from '../ids.ts';

/** 项目里的一等 bot（C3a）：按 id / (projectId, name) 查，整条存。 */
export interface BotRepository {
  byId(id: BotId): Promise<Bot | null>;
  byName(projectId: ProjectId, name: string): Promise<Bot | null>;
  /** 项目里的 bot，按创建顺序（created_at，再按 name）。 */
  list(projectId: ProjectId): Promise<readonly Bot[]>;
  save(bot: Bot): Promise<void>;
  remove(id: BotId): Promise<void>;
}
