import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReposUseCase, type RepoCheckProbe, type RepoCheckTarget } from './repo-check.ts';

const target = (name: string, branch: string | null): RepoCheckTarget => ({ name, url: `https://example.test/me/${name}.git`, branch });

test('checkReposUseCase：全部可达、分支在 → ok，message 为 null', async () => {
  const seen: RepoCheckTarget[] = [];
  const results = await checkReposUseCase(
    {
      checkRepo: async (input) => {
        seen.push(input);
        return { reachable: true, defaultBranch: 'main', branchExists: true, message: null };
      }
    },
    [target('api', 'main'), target('web', null)]
  );
  assert.deepEqual(seen, [target('api', 'main'), target('web', null)]);
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, true]
  );
  assert.ok(results.every((result) => result.message === null && result.defaultBranch === 'main'));
});

test('checkReposUseCase：分支不存在 → ok=false，message 带上分支名和默认分支', async () => {
  const results = await checkReposUseCase(
    { checkRepo: async () => ({ reachable: true, defaultBranch: 'main', branchExists: false, message: null }) },
    [target('api', 'master')]
  );
  assert.equal(results[0]!.ok, false);
  assert.equal(results[0]!.defaultBranch, 'main');
  assert.match(results[0]!.message ?? '', /没有分支 master/);
  assert.match(results[0]!.message ?? '', /默认分支是 main/);
});

test('checkReposUseCase：不可达 → ok=false，原 message 原样带上', async () => {
  const results = await checkReposUseCase(
    { checkRepo: async (): Promise<RepoCheckProbe> => ({ reachable: false, defaultBranch: null, branchExists: false, message: 'Repository not found' }) },
    [target('api', 'main')]
  );
  assert.equal(results[0]!.ok, false);
  assert.equal(results[0]!.defaultBranch, null);
  assert.equal(results[0]!.message, 'Repository not found');
});

test('checkReposUseCase：串行最多 8 个，注入方抛错也只算那一个失败', async () => {
  const order: string[] = [];
  const results = await checkReposUseCase(
    {
      checkRepo: async (input) => {
        order.push(input.name);
        if (input.name === 'repo-8') return { reachable: true, defaultBranch: 'main', branchExists: true, message: null };
        throw new Error('boom');
      }
    },
    Array.from({ length: 9 }, (_, index) => target(`repo-${index}`, 'main'))
  );
  assert.equal(results.length, 8);
  assert.deepEqual(order, ['repo-0', 'repo-1', 'repo-2', 'repo-3', 'repo-4', 'repo-5', 'repo-6', 'repo-7']);
  assert.equal(results[0]!.message, 'boom');
});
