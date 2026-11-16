import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LoginId, Principal, TeamId, User, UserId } from '../account.ts';
import { asProjectId } from '../ids.ts';
import { createProject } from '../project.ts';
import { fakeProjects, inMemoryAdmin, inMemoryAssetReviewDeps, inMemoryAssets } from '../testing/in-memory.ts';
import { uploadAsset } from './assets.ts';
import {
  createAssetSetUseCase,
  listAssetSetsUseCase,
  removeAssetSetUseCase,
  setProjectAssetSetsUseCase,
  updateAssetSetUseCase,
  type AssetSetDeps
} from './asset-sets.ts';

const enc = (text: string) => new TextEncoder().encode(text);
const skill = (name: string) => [{ path: 'SKILL.md', data: enc(`---\nname: ${name}\ndescription: d\n---\nhi\n`) }];

/** 世界：团队 T1（负责人 O + 成员 M），团队 T2（S）。 */
async function world() {
  const admin = inMemoryAdmin();
  const assets = inMemoryAssets();
  const review = inMemoryAssetReviewDeps(admin, assets);
  const projects = fakeProjects();
  const setRepo = review.assetSets;
  const deps: AssetSetDeps = {
    assetSets: setRepo,
    assets: review.deps.assets,
    projects,
    audit: admin.deps.audit,
    now: () => 1_000
  };
  const people: Record<string, Principal> = {};
  const mk = async (key: string, team: string, role: 'owner' | 'member') => {
    const user: User = {
      id: `u-${key}` as UserId,
      email: `${key.toLowerCase()}@x.co`,
      displayName: key,
      role,
      passwordHash: null,
      emailVerifiedAt: 1,
      disabledAt: null,
      createdAt: 1,
      teamId: team as TeamId,
      clusterAdmin: false,
      deletedAt: null
    };
    await admin.accounts.users.save(user);
    if (role === 'owner') await admin.accounts.teams.save({ id: team as TeamId, name: team, ownerId: user.id, createdAt: 1 });
    people[key] = { user, loginId: `l-${key}` as LoginId };
  };
  await mk('O', 't1', 'owner');
  await mk('M', 't1', 'member');
  await mk('S', 't2', 'owner');
  const p = (key: string) => people[key]!;
  const project = createProject({ name: 'demo', now: 1, teamId: 't1' as TeamId, createdBy: 'u-O' as UserId });
  assert.ok(project.ok);
  await projects.save(project.value);
  return { deps, assets, projects, setRepo, p, project: project.value };
}

test('资产组合：团队隔离、重名 409、非创建者 403、删被引用 409', async () => {
  const { deps, assets, projects, setRepo, p, project } = await world();
  const uploaded = await uploadAsset(assets.deps, { kind: 'skill', files: skill('greeter') });
  assert.ok(uploaded.ok);
  const assetId = uploaded.value.id;

  const made = await createAssetSetUseCase(deps, p('O'), { name: '基础', items: [{ assetId }] });
  assert.ok(made.ok);
  const list = await listAssetSetsUseCase(deps, p('O'));
  assert.ok(list.ok);
  assert.equal(list.value.length, 1);

  // 另一个团队看不见、也改不了。
  const otherList = await listAssetSetsUseCase(deps, p('S'));
  assert.ok(otherList.ok);
  assert.deepEqual(otherList.value, []);
  const stolen = await updateAssetSetUseCase(deps, p('S'), made.value.id, { name: '偷', items: [] });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.ok === false && stolen.error.code, 'not_found');

  // 重名。
  const dup = await createAssetSetUseCase(deps, p('O'), { name: '基础', items: [] });
  assert.equal(dup.ok, false);
  assert.equal(dup.ok === false && dup.error.code, 'conflict');
  assert.match(dup.ok === false ? dup.error.message : '', /团队里已经有叫「基础」的资产组合/);

  // 同团队非创建者不能改。
  const denied = await updateAssetSetUseCase(deps, p('M'), made.value.id, { name: '改', items: [] });
  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false && denied.error.code, 'forbidden');

  // 被项目引用时不能删。
  await projects.save({ ...project, assetSetIds: [made.value.id] });
  const blocked = await removeAssetSetUseCase(deps, p('O'), made.value.id);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.error.code, 'conflict');
  assert.match(blocked.ok === false ? blocked.error.message : '', /还有 1 个项目在用它，先解绑/);

  await projects.save({ ...project, assetSetIds: [] });
  assert.ok((await removeAssetSetUseCase(deps, p('O'), made.value.id)).ok);
  assert.deepEqual(setRepo.rows.size, 0);
});

test('项目默认组合：只能绑本项目团队的组合', async () => {
  const { deps, projects, setRepo, p, project } = await world();
  const mine = await createAssetSetUseCase(deps, p('O'), { name: 'mine', items: [] });
  assert.ok(mine.ok);
  const bound = await setProjectAssetSetsUseCase({ assetSets: setRepo, projects }, p('O'), project.id, [mine.value.id]);
  assert.ok(bound.ok);
  assert.deepEqual(bound.value.assetSetIds, [mine.value.id]);

  await setRepo.save({
    id: 'aset_foreign',
    teamId: 't2' as never,
    name: 'foreign',
    description: null,
    items: [],
    createdBy: null,
    createdAt: 1,
    updatedAt: 1
  });
  // 别的团队的组合、不存在的组合都按 400。
  const foreign = await setProjectAssetSetsUseCase({ assetSets: setRepo, projects }, p('O'), project.id, ['aset_foreign']);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.ok === false && foreign.error.code, 'invalid');
  assert.match(foreign.ok === false ? foreign.error.message : '', /组合不属于这个项目所在的团队/);
  const missing = await setProjectAssetSetsUseCase({ assetSets: setRepo, projects }, p('O'), project.id, ['aset_missing']);
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.error.code, 'invalid');
  assert.equal(project.id, asProjectId(project.id));
});
