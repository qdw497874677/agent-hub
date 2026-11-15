import type { BotId } from './bot.ts';
import type { ProjectId, WorkspaceId } from './ids.ts';

/**
 * 「这个 bot 可以在哪个项目里干活」（ADR 0036 后续：bot 是团队级实体，不隶属项目）。
 *
 * 授权就是它在那个项目里的通行证：
 * - 能被拉进该项目的群、被 `bot:<name>` 地址寻址、能在该项目的任务里跑会话；
 * - 撤销授权时调用方负责把它从群成员、连接器绑定上摘掉（与删 bot 同一套收尾）。
 *
 * `workspaceId` 是这个 bot 在该项目里的默认落点（可空 = 用项目默认工作空间）。
 * 放在授权上而不是 bot 上：同一个 bot 在不同项目里可能该跑在不同机器/目录。
 */
export interface PersistentAgentGrant {
  readonly botId: BotId;
  readonly projectId: ProjectId;
  /** 该项目里默认落在哪个工作空间；null = 跟随项目默认。 */
  readonly workspaceId: WorkspaceId | null;
  readonly createdAt: number;
  readonly createdBy: string | null;
}

/** 兼容名：新代码用 `PersistentAgentGrant`。 */
export type BotGrant = PersistentAgentGrant;
