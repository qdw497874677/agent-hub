import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterModelsByScope, modelScope, sameModelScope, scopeNote } from './model-scope.ts';

const hub = (value: string) => ({ value, label: value });

test('作用域：hub-<slug>/… 是 hub，其余是原生', () => {
  assert.deepEqual(modelScope('hub-team-1/glm-5'), { kind: 'hub', slug: 'team-1' });
  assert.deepEqual(modelScope('my-codex/zp-glm-5.3-flash'), { kind: 'native' });
  assert.deepEqual(modelScope('opencode-go/glm-5.3'), { kind: 'native' });
  assert.deepEqual(modelScope('local'), { kind: 'native' });
  assert.deepEqual(modelScope(''), { kind: 'native' });
  assert.deepEqual(modelScope(undefined), { kind: 'native' });
});

test('作用域：hub- 但拆不出合法 slug / 模型的，按原生算（跟 parseHubModel 一致）', () => {
  assert.deepEqual(modelScope('hub-'), { kind: 'native' });
  assert.deepEqual(modelScope('hub-team-1'), { kind: 'native' });
  assert.deepEqual(modelScope('hub-team-1/'), { kind: 'native' });
  assert.deepEqual(modelScope('hub-Team/glm-5'), { kind: 'native' });
});

test('同类判定：hub 同 slug 才算同类，原生之间都同类，跨类不同类', () => {
  assert.equal(sameModelScope('hub-a/x', 'hub-a/y'), true);
  assert.equal(sameModelScope('hub-a/x', 'hub-b/x'), false);
  assert.equal(sameModelScope('my-codex/glm-5.3', 'opencode-go/glm-5.3'), true);
  assert.equal(sameModelScope('hub-a/x', 'my-codex/glm-5.3'), false);
  assert.equal(sameModelScope('local', 'openai/gpt-5'), true);
});

test('过滤：hub 当前值只留同一 slug 的模型', () => {
  const items = [hub('hub-a/x'), hub('hub-a/y'), hub('hub-b/z'), hub('my-codex/glm-5.3')];
  assert.deepEqual(filterModelsByScope(items, 'hub-a/x'), {
    items: [hub('hub-a/x'), hub('hub-a/y')],
    hidden: 2
  });
});

test('过滤：原生当前值留全部原生模型，藏掉所有 hub 模型', () => {
  const items = [hub('hub-a/x'), hub('hub-b/z'), hub('my-codex/glm-5.3'), hub('local')];
  assert.deepEqual(filterModelsByScope(items, 'my-codex/glm-5.3'), {
    items: [hub('my-codex/glm-5.3'), hub('local')],
    hidden: 2
  });
  assert.equal(scopeNote('my-codex/glm-5.3'), 'hub 提供商的模型需要新开会话');
  assert.equal(scopeNote('hub-a/x'), '其他提供商的模型需要新开会话');
});

test('过滤：当前值一定留着（哪怕清单里没有它，也不会凭空造一条）', () => {
  const items = [hub('hub-a/x'), hub('hub-b/z')];
  const result = filterModelsByScope(items, 'hub-a/current-only');
  assert.deepEqual(result.items, [hub('hub-a/x')]);
  assert.equal(result.hidden, 1);

  const mixed = [hub('hub-a/x'), hub('my-codex/glm-5.3')];
  assert.deepEqual(filterModelsByScope(mixed, 'my-codex/glm-5.3').items, [hub('my-codex/glm-5.3')]);
});

test('过滤：空清单不出错，也不会多算藏起来的个数', () => {
  assert.deepEqual(filterModelsByScope([], 'my-codex/glm-5.3'), { items: [], hidden: 0 });
  assert.deepEqual(filterModelsByScope([], 'hub-a/x'), { items: [], hidden: 0 });
});

test('过滤：全是同一类时一条都不藏', () => {
  const items = [hub('my-codex/glm-5.3'), hub('opencode-go/glm-5.3')];
  const result = filterModelsByScope(items, 'my-codex/glm-5.3');
  assert.equal(result.hidden, 0);
  assert.deepEqual(result.items, items);
});
