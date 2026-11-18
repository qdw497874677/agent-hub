import { asProjectId, can, projectReader, scopedTokenSeesAsset } from '@agent-hub/domain';
import type { AccessPolicy, Asset, Principal, ProjectRepository } from '@agent-hub/domain';

/**
 * 开放 API 看资产时的可见范围（ADR 0015/0016）：先看令牌有没有 asset.read，再看归属。
 * - global：所有人可见
 * - team：同团队
 * - personal：只给作者本人
 * - project：项目可读（走同一套 projectReader，含共享与集群管理员临时进入）
 * 限定项目的令牌先收窄：全局可读；团队资产只限项目所在团队；个人资产看不到（scopedTokenSeesAsset）。
 */
export function createAssetVisibility(
  deps: { readonly access?: AccessPolicy; readonly projects: Pick<ProjectRepository, 'byId'> },
  actor: Principal
): (asset: Asset) => Promise<boolean> {
  const readerPromise = projectReader(deps.access, actor);
  return async (asset) => {
    if (!can(actor, 'asset.read')) return false;
    if (scopedTokenSeesAsset(actor.via, asset) === false) return false;
    if (asset.scope === 'global') return true;
    if (asset.scope === 'personal') return asset.ownerId === actor.user.id;
    if (asset.scope === 'team') return asset.teamId !== null && asset.teamId === actor.user.teamId;
    if (asset.projectId === null) return false;
    const project = await deps.projects.byId(asProjectId(asset.projectId));
    if (!project || project.deletedAt !== null) return false;
    const reader = await readerPromise;
    return reader(project);
  };
}
