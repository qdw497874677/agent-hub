import { can, type Subject } from '../access.ts';
import type { Principal } from '../account.ts';
import {
  normalizeAssetSetIds,
  normalizeAssetSetItems,
  newAssetSetId,
  ASSET_SET_DESCRIPTION_MAX,
  ASSET_SET_NAME_MAX,
  type AssetSet,
  type AssetSetItem
} from '../asset-set.ts';
import { assetVisibleIn, isPublished, type Asset } from '../asset.ts';
import { conflict, forbidden, invalid, notFound, unavailable, type DomainError } from '../errors.ts';
import type { AssetRepository } from '../ports/asset-repository.ts';
import type { AssetSetRepository } from '../ports/asset-set-repository.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { ProjectRepository } from '../ports/project-repository.ts';
import { projectResource, type Project } from '../project.ts';
import { err, ok, type Result } from '../result.ts';

/** 资产组合用例的依赖：组合本身 + 校验资产可见性 + 项目绑定。 */
export interface AssetSetDeps {
  readonly assetSets: AssetSetRepository;
  readonly assets: Pick<AssetRepository, 'get'>;
  readonly projects: {
    byId(id: string): Promise<{ readonly id: string; readonly name: string } | null>;
    /** 删组合前要看还有哪些项目引用它。 */
    list?(): Promise<readonly Project[]>;
  };
  readonly audit: AuditLog;
  readonly now: () => number;
}

/** 项目默认组合：要读完整项目（团队、成员）才能判权限并回写。 */
export interface ProjectAssetSetDeps {
  readonly assetSets: Pick<AssetSetRepository, 'byId'>;
  readonly projects: Pick<ProjectRepository, 'byId' | 'save'>;
}

export interface AssetSetInput {
  readonly name: string;
  readonly description?: string | null;
  readonly items: readonly AssetSetItem[];
}

const teamOf = (actor: Principal): string | null => actor.user.teamId ?? null;

/** 组合里的资产必须是自己团队看得见的：自己的、已发布的全局、同团队的团队 / 项目资产。 */
function assetBelongsToTeam(asset: Asset, actor: Principal, teamId: string): boolean {
  if (asset.ownerId === actor.user.id) return true;
  if (!isPublished(asset)) return false;
  if (asset.scope === 'global') return true;
  if (asset.scope === 'personal') return false;
  return asset.teamId === teamId && assetVisibleIn(asset, asset.projectId ?? '', {
    userId: actor.user.id,
    teamId
  });
}

function normalizeInput(input: AssetSetInput): Result<{ name: string; description: string | null; items: readonly AssetSetItem[] }, DomainError> {
  const name = input.name.trim();
  if (name === '') return err(invalid('资产组合名字不能为空'));
  if (name.length > ASSET_SET_NAME_MAX) return err(invalid(`资产组合名字最多 ${ASSET_SET_NAME_MAX} 个字`));
  const description = input.description?.trim() ?? '';
  if (description.length > ASSET_SET_DESCRIPTION_MAX) {
    return err(invalid(`资产组合说明最多 ${ASSET_SET_DESCRIPTION_MAX} 个字`));
  }
  const items = normalizeAssetSetItems(input.items);
  if (!items.ok) return items;
  return ok({ name, description: description === '' ? null : description, items: items.value });
}

async function checkItems(deps: AssetSetDeps, actor: Principal, teamId: string, items: readonly AssetSetItem[]): Promise<Result<void, DomainError>> {
  for (const item of items) {
    const asset = await deps.assets.get(item.assetId);
    if (!asset || !assetBelongsToTeam(asset, actor, teamId)) {
      return err(invalid(`资产 ${item.assetId} 不存在或你看不见`));
    }
  }
  return ok(undefined);
}

/** 团队里的资产组合，最近更新的在前。 */
export async function listAssetSetsUseCase(deps: AssetSetDeps, actor: Principal): Promise<Result<readonly AssetSet[], DomainError>> {
  if (!can(actor, 'asset.read')) return err(forbidden('你没有查看资产组合的权限'));
  const teamId = teamOf(actor);
  if (teamId === null) return ok([]);
  const sets = await deps.assetSets.listByTeam(teamId);
  return ok([...sets].sort((a, b) => b.updatedAt - a.updatedAt));
}

export async function createAssetSetUseCase(
  deps: AssetSetDeps,
  actor: Principal,
  input: AssetSetInput
): Promise<Result<AssetSet, DomainError>> {
  if (!can(actor, 'asset.submit')) return err(forbidden('你没有创建资产组合的权限'));
  const teamId = teamOf(actor);
  if (teamId === null) return err(invalid('你还没有团队，不能建资产组合'));
  const normalized = normalizeInput(input);
  if (!normalized.ok) return normalized;
  const { name, description, items } = normalized.value;
  const existing = await deps.assetSets.listByTeam(teamId);
  if (existing.some((set) => set.name === name)) return err(conflict(`团队里已经有叫「${name}」的资产组合`));
  const checked = await checkItems(deps, actor, teamId, items);
  if (!checked.ok) return checked;

  const now = deps.now();
  const set: AssetSet = {
    id: newAssetSetId(),
    teamId,
    name,
    description,
    items,
    createdBy: actor.user.id,
    createdAt: now,
    updatedAt: now
  };
  await deps.assetSets.save(set);
  await deps.audit.append({
    id: newAssetSetId(),
    actorId: actor.user.id,
    actorEmail: actor.user.email,
    action: 'asset.set_create',
    target: set.id,
    detail: `组合「${name}」${items.length} 项`,
    at: now,
    teamId
  });
  return ok(set);
}

/** 只有创建者或团队 owner/admin 能改；团队外的人一律当没这个组合。 */
function canModify(actor: Principal, set: AssetSet): boolean {
  if (set.createdBy !== null && set.createdBy === actor.user.id) return true;
  return can(actor, 'team.manage', { teamId: set.teamId });
}

export async function updateAssetSetUseCase(
  deps: AssetSetDeps,
  actor: Principal,
  id: string,
  input: AssetSetInput
): Promise<Result<AssetSet, DomainError>> {
  const existing = await deps.assetSets.byId(id);
  if (!existing || existing.teamId !== teamOf(actor)) return err(notFound('没有这个资产组合'));
  if (!canModify(actor, existing)) return err(forbidden('只有创建者或团队负责人能改这个资产组合'));
  const normalized = normalizeInput(input);
  if (!normalized.ok) return normalized;
  const { name, description, items } = normalized.value;
  const teamId = existing.teamId;
  const siblings = await deps.assetSets.listByTeam(teamId);
  if (siblings.some((set) => set.id !== existing.id && set.name === name)) {
    return err(conflict(`团队里已经有叫「${name}」的资产组合`));
  }
  const checked = await checkItems(deps, actor, teamId, items);
  if (!checked.ok) return checked;

  const now = deps.now();
  const updated: AssetSet = { ...existing, name, description, items, updatedAt: now };
  await deps.assetSets.save(updated);
  await deps.audit.append({
    id: newAssetSetId(),
    actorId: actor.user.id,
    actorEmail: actor.user.email,
    action: 'asset.set_update',
    target: updated.id,
    detail: `组合「${name}」${items.length} 项`,
    at: now,
    teamId
  });
  return ok(updated);
}

export async function removeAssetSetUseCase(deps: AssetSetDeps, actor: Principal, id: string): Promise<Result<void, DomainError>> {
  const existing = await deps.assetSets.byId(id);
  if (!existing || existing.teamId !== teamOf(actor)) return err(notFound('没有这个资产组合'));
  if (!canModify(actor, existing)) return err(forbidden('只有创建者或团队负责人能删这个资产组合'));
  if (!deps.projects.list) return err(unavailable('项目列表不可用，暂时不能确认组合是否被引用'));
  const projects = await deps.projects.list();
  const usedBy = projects.filter((project) => (project.assetSetIds ?? []).includes(id)).length;
  if (usedBy > 0) return err(conflict(`还有 ${usedBy} 个项目在用它，先解绑`));

  await deps.assetSets.remove(id);
  await deps.audit.append({
    id: newAssetSetId(),
    actorId: actor.user.id,
    actorEmail: actor.user.email,
    action: 'asset.set_remove',
    target: existing.id,
    detail: `组合「${existing.name}」${existing.items.length} 项`,
    at: deps.now(),
    teamId: existing.teamId
  });
  return ok(undefined);
}

/** 项目的默认组合：每个组合都必须属于项目所在的团队。 */
export async function setProjectAssetSetsUseCase(
  deps: ProjectAssetSetDeps,
  actor: Subject,
  projectId: string,
  assetSetIds: readonly string[] | null | undefined
): Promise<Result<Project, DomainError>> {
  const project = await deps.projects.byId(projectId as Project['id']);
  if (!project) return err(notFound('项目不存在'));
  if (!can(actor, 'project.update', projectResource(project))) return err(forbidden('你没有修改项目的权限'));
  const normalized = normalizeAssetSetIds(assetSetIds);
  if (!normalized.ok) return normalized;
  for (const id of normalized.value) {
    const set = await deps.assetSets.byId(id);
    if (!set || set.teamId !== project.teamId) return err(invalid('组合不属于这个项目所在的团队'));
  }
  const updated: Project = { ...project, assetSetIds: normalized.value };
  await deps.projects.save(updated);
  return ok(updated);
}
