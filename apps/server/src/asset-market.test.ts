import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAdmin, inMemoryAssetReviewDeps, inMemoryAssets, inMemoryDeps } from '@agent-hub/domain/testing';
import type { AssetReader } from '@agent-hub/domain';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';

const PASSWORD = 'long enough pw';
const enc = (text: string) => new TextEncoder().encode(text);
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

function harness() {
  const admin = inMemoryAdmin();
  const assets = inMemoryAssets();
  const { deps } = inMemoryDeps();
  const review = inMemoryAssetReviewDeps(admin, assets);
  const names: Record<string, string> = { 'skills/a': 'alpha', 'skills/b': 'beta' };
  const reader: AssetReader = {
    describe: review.deps.reader.describe,
    diffText: review.deps.reader.diffText,
    scanGit: async () => ({
      ok: true,
      value: {
        commit: 'c0ffee',
        candidates: [
          { kind: 'skill', path: 'skills/a', name: 'alpha', description: 'A' },
          { kind: 'skill', path: 'skills/b', name: 'beta', description: 'B' }
        ]
      }
    }),
    readGit: async (_url, _ref, path) => ({
      ok: true,
      value: {
        commit: 'c0ffee',
        files: [{ path: 'SKILL.md', data: enc(`---\nname: ${names[path] ?? 'unknown'}\ndescription: d\n---\nbody`) }]
      }
    })
  };
  const app = createApp({
    deps,
    hub: createStreamHub(),
    token: null,
    auth: { accounts: admin.accounts },
    admin: { deps: admin.deps },
    assets: { deps: { ...review.deps, reader, projects: deps.projects }, audit: admin.deps.audit, assetSets: review.assetSets }
  });
  const browser = () => {
    const jar = new Map<string, string>();
    return async (path: string, init: RequestInit = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (jar.get('hub_csrf')) headers['x-hub-csrf'] = jar.get('hub_csrf')!;
      const response = await app.fetch(new Request(`http://hub${path}`, { ...init, headers }));
      for (const line of response.headers.getSetCookie()) {
        const [name, value] = line.split(';')[0]!.split('=');
        jar.set(name!, value!);
      }
      return { status: response.status, body: (await response.json().catch(() => null)) as any };
    };
  };
  return { browser };
}

test('批量导入：逐项复用单条导入，单项失败不影响其它项；locked 默认钉提交、track 留 ref', async () => {
  const h = harness();
  const owner = h.browser();
  assert.equal((await owner('/api/auth/register', post({ email: 'boss@b.co', password: PASSWORD }))).status, 200);

  const batched = await owner(
    '/api/assets/git/batch',
    post({
      items: [
        // 直接粘 GitHub 网址：tree/main 拆出仓库、ref 与路径
        { url: 'https://github.com/o/r/tree/main/skills/a', scope: 'global' },
        { url: 'https://github.com/o/r', path: 'skills/missing' },
        { url: 'https://github.com/o/r', ref: 'main', path: 'skills/b', policy: 'track', scope: 'global' }
      ]
    })
  );
  assert.equal(batched.status, 200);
  assert.equal(batched.body.length, 3);
  assert.equal(batched.body[0].ok, true);
  assert.equal(batched.body[0].name, 'alpha');
  assert.equal(batched.body[1].ok, false);
  assert.match(batched.body[1].error, /没有这个路径的资产/);
  assert.equal(batched.body[2].ok, true);

  const overview = (await owner('/api/admin/assets')).body.assets as any[];
  const alpha = overview.find((asset) => asset.name === 'alpha');
  const beta = overview.find((asset) => asset.name === 'beta');
  assert.equal(alpha.source.ref, 'c0ffee', 'locked：ref 记成解析出的提交');
  assert.equal(alpha.source.policy, 'locked');
  assert.equal(beta.source.ref, 'main', 'track：保留分支');
  assert.equal(beta.source.policy, 'track');

  // 单条失败不落库，成功的两条都在
  assert.deepEqual(overview.map((asset) => asset.name).sort(), ['alpha', 'beta']);

  const tooMany = await owner(
    '/api/assets/git/batch',
    post({ items: Array.from({ length: 21 }, (_, i) => ({ url: `https://github.com/o/r-${i}` })) })
  );
  assert.equal(tooMany.status, 400, '一次最多 20 项');
});
