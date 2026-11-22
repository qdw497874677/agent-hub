import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { deriveRepoId, repoTokenKey, type ProjectRepo } from '../project.ts';
import type { Deps } from './deps.ts';
import { createProjectUseCase } from './projects.ts';

const API = 'https://git.example.test/me/api.git';
const WEB = 'https://git.example.test/me/web.git';

const assertInvalid = (result: { ok: boolean; error?: { code: string; message: string } }, pattern: RegExp) => {
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'invalid');
  assert.match(result.error?.message ?? '', pattern);
};

test('创建：不绑仓库（零仓库）仍然得到空清单和空主仓库', async () => {
  const { deps } = inMemoryDeps();
  const created = await createProjectUseCase(deps, { name: 'empty', primaryRepoId: null });
  assert.ok(created.ok);
  assert.deepEqual(created.value.repos, []);
  assert.equal(created.value.repo, null);
  assert.equal(created.value.primaryRepoId, null);
  assert.deepEqual(await deps.secrets.list(), []);
  // 绑定配置不 clone：没有任何 git / worker 指令。
  assert.deepEqual(await deps.projects.list(), [created.value]);
});

test('创建：老的单仓库 repoUrl/defaultBranch 照旧工作', async () => {
  const { deps } = inMemoryDeps();
  const created = await createProjectUseCase(deps, { name: 'legacy', repoUrl: API, defaultBranch: 'main' });
  assert.ok(created.ok);
  assert.equal(created.value.repos.length, 1);
  const repo = created.value.repos[0]!;
  assert.equal(repo.id, deriveRepoId('api', API));
  assert.equal(repo.name, 'api');
  assert.equal(repo.url, API);
  assert.equal(repo.defaultBranch, 'main');
  assert.deepEqual(created.value.repo, { url: API, defaultBranch: 'main' });
  assert.equal(created.value.primaryRepoId, null);
  assert.equal('tokenSecret' in repo, false);
});

test('创建：多仓库 + 指定的主仓库一起落库，repo 仍是第一个', async () => {
  const { deps } = inMemoryDeps();
  const created = await createProjectUseCase(deps, {
    name: 'multi',
    repos: [
      { id: 'repo_api', name: 'api', url: API, defaultBranch: 'main' },
      { id: 'repo_web', name: 'web', url: WEB }
    ],
    primaryRepoId: 'repo_web'
  });
  assert.ok(created.ok);
  assert.deepEqual(created.value.repos.map((repo) => repo.id), ['repo_api', 'repo_web']);
  assert.equal(created.value.primaryRepoId, 'repo_web');
  assert.deepEqual(created.value.repo, { url: API, defaultBranch: 'main' });
  const saved = await deps.projects.byId(created.value.id);
  assert.deepEqual(saved, created.value);
  assert.deepEqual(await deps.secrets.list(), []);
});

test('创建：主仓库不在清单里时整体失败，不落项目', async () => {
  const { deps } = inMemoryDeps();
  const result = await createProjectUseCase(deps, {
    name: 'bad-primary',
    repos: [{ name: 'api', url: API }],
    primaryRepoId: 'repo_missing'
  });
  assertInvalid(result, /主仓库/);
  assert.deepEqual(await deps.projects.list(), []);
  assert.deepEqual(await deps.secrets.list(), []);
});

test('创建：老字段和新清单混用直接拒绝，不落项目', async () => {
  const { deps } = inMemoryDeps();
  const result = await createProjectUseCase(deps, {
    name: 'mixed',
    repoUrl: API,
    repos: [{ name: 'web', url: WEB }]
  });
  assertInvalid(result, /不能同时给/);
  assert.deepEqual(await deps.projects.list(), []);
});

test('创建：只给 primaryRepoId（没给 repos）拒绝，不落项目', async () => {
  const { deps } = inMemoryDeps();
  const result = await createProjectUseCase(deps, { name: 'orphan-primary', primaryRepoId: 'repo_api' });
  assertInvalid(result, /primaryRepoId/);
  assert.deepEqual(await deps.projects.list(), []);
});

test('创建：仓库清单沿用同一套规则（重复名字 / 超上限 / 非法 id 重复）', async () => {
  const { deps } = inMemoryDeps();
  const duplicateName = await createProjectUseCase(deps, {
    name: 'dup',
    repos: [
      { name: 'api', url: API },
      { name: 'api', url: WEB }
    ]
  });
  assertInvalid(duplicateName, /仓库名重复/);

  const tooMany = await createProjectUseCase(deps, {
    name: 'many',
    repos: Array.from({ length: 9 }, (_, index) => ({ name: `repo-${index}`, url: `https://git.example.test/me/r${index}.git` }))
  });
  assertInvalid(tooMany, /最多 8 个仓库/);

  const duplicateId = await createProjectUseCase(deps, {
    name: 'dup-id',
    repos: [
      { id: 'repo_same', name: 'api', url: API },
      { id: 'repo_same', name: 'web', url: WEB }
    ]
  });
  assertInvalid(duplicateId, /仓库 id 重复/);
  assert.deepEqual(await deps.projects.list(), []);
});

test('创建：仓库地址里带用户名 / 密码拒绝（老的 repoUrl 也一样），不写密钥', async () => {
  const { deps } = inMemoryDeps();
  const newShape = await createProjectUseCase(deps, {
    name: 'url-token',
    repos: [{ name: 'api', url: 'https://me:glpat-in-url@git.example.test/me/api.git' }]
  });
  assertInvalid(newShape, /不能带用户名或密码/);

  const legacy = await createProjectUseCase(deps, {
    name: 'url-token-legacy',
    repoUrl: 'https://me:glpat-in-url@git.example.test/me/api.git'
  });
  assertInvalid(legacy, /不能带用户名或密码/);

  assert.deepEqual(await deps.projects.list(), []);
  assert.deepEqual(await deps.secrets.list(), []);
});

test('创建：credential 只进规范密钥箱，项目对象只有 tokenSecret 名字、没有明文', async () => {
  const { deps } = inMemoryDeps();
  const created = await createProjectUseCase(deps, {
    name: 'private',
    repos: [
      { id: 'repo_api', name: 'api', url: API, credential: '  glpat-api  ' },
      { id: 'repo_web', name: 'web', url: WEB },
      { id: 'repo_docs', name: 'docs', url: 'https://git.example.test/me/docs.git', credential: 'glpat-docs' }
    ]
  });
  assert.ok(created.ok);
  const [api, web, docs] = created.value.repos as ProjectRepo[];
  const apiKey = repoTokenKey(created.value.id, 'repo_api');
  const docsKey = repoTokenKey(created.value.id, 'repo_docs');
  assert.equal(api?.tokenSecret, apiKey);
  assert.equal(web?.tokenSecret, undefined);
  assert.equal(docs?.tokenSecret, docsKey);
  // 明文只进密钥箱，trim 过；没给 credential 的行不产生条目。
  assert.deepEqual(await deps.secrets.reveal([apiKey, docsKey]), { [apiKey]: 'glpat-api', [docsKey]: 'glpat-docs' });
  assert.deepEqual((await deps.secrets.list()).map((entry) => entry.name).sort(), [apiKey, docsKey].sort());
  const serialized = JSON.stringify(created.value);
  assert.equal(serialized.includes('glpat-api'), false);
  assert.equal(serialized.includes('glpat-docs'), false);
  // 持久化后的项目也只有一个键名。
  const saved = await deps.projects.byId(created.value.id);
  assert.equal(saved?.repos[0]?.tokenSecret, apiKey);
  assert.equal(JSON.stringify(saved).includes('glpat-api'), false);
});

test('创建：调用方自带的 tokenSecret 一律忽略，也不读 / 不删它指向的键', async () => {
  const { deps } = inMemoryDeps();
  const foreign = repoTokenKey('project_other', 'repo_api');
  await deps.secrets.put(foreign, 'foreign-token', 1);
  const created = await createProjectUseCase(deps, {
    name: 'ignored',
    repos: [{ id: 'repo_api', name: 'api', url: API, tokenSecret: foreign }]
  });
  assert.ok(created.ok);
  assert.equal(created.value.repos[0]?.tokenSecret, undefined);
  assert.deepEqual(await deps.secrets.reveal([foreign]), { [foreign]: 'foreign-token' });
});

test('创建：密钥箱写入失败时项目不落库（不留缺令牌的半成品）', async () => {
  const memory = inMemoryDeps();
  let calls = 0;
  const failing = {
    ...memory.deps,
    secrets: {
      ...memory.deps.secrets,
      put: async (name: string, value: string, at: number) => {
        calls += 1;
        if (calls === 2) throw new Error('vault down');
        await memory.deps.secrets.put(name, value, at);
      }
    }
  } as Deps;
  await assert.rejects(
    createProjectUseCase(failing, {
      name: 'vault-down',
      repos: [
        { id: 'repo_api', name: 'api', url: API, credential: 'glpat-api' },
        { id: 'repo_web', name: 'web', url: WEB, credential: 'glpat-web' }
      ]
    }),
    /vault down/
  );
  assert.deepEqual(await memory.deps.projects.list(), []);
  // 第一条已经写进去的令牌也要回收。
  assert.deepEqual(await memory.deps.secrets.list(), []);
});

test('创建：工作空间认领冲突时回收令牌且不落项目', async () => {
  const memory = inMemoryDeps();
  const failing = {
    ...memory.deps,
    projects: {
      ...memory.deps.projects,
      saveWithWorkspaceClaim: (async () => ({ status: 'conflict' })) as never
    }
  } as Deps;
  const result = await createProjectUseCase(failing, {
    name: 'conflict',
    rootPath: '/tmp/create-repos-conflict',
    repos: [{ id: 'repo_api', name: 'api', url: API, credential: 'glpat-api' }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'conflict');
  assert.deepEqual(await memory.deps.projects.list(), []);
  assert.deepEqual(await memory.deps.secrets.list(), []);
});

test('创建：项目保存失败时回收本次写进密钥箱的令牌', async () => {
  const memory = inMemoryDeps();
  const failing = {
    ...memory.deps,
    projects: {
      ...memory.deps.projects,
      save: async () => {
        throw new Error('db down');
      }
    }
  } as Deps;
  await assert.rejects(
    createProjectUseCase(failing, { name: 'db-down', repos: [{ id: 'repo_api', name: 'api', url: API, credential: 'glpat-api' }] }),
    /db down/
  );
  assert.deepEqual(await memory.deps.projects.list(), []);
  assert.deepEqual(await memory.deps.secrets.list(), []);
});
