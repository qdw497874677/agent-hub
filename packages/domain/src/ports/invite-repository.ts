import type { Invite, InviteId, TeamId } from '../account.ts';

export interface InviteRepository {
  save(invite: Invite): Promise<void>;
  byId(id: InviteId): Promise<Invite | null>;
  byTokenHash(tokenHash: string): Promise<Invite | null>;
  /** 团队的全部邀请（含已用 / 已撤销 / 过期的），新的在前。 */
  forTeam(teamId: TeamId): Promise<Invite[]>;
  /** 全 hub 还没用、没撤销、没过期的邀请（算名额用）。 */
  pending(now: number): Promise<Invite[]>;
  /** 原子地用掉一个邀请：哈希对得上且仍待接受才标记 accepted 并返回；否则 null。 */
  accept(tokenHash: string, now: number): Promise<Invite | null>;
}
