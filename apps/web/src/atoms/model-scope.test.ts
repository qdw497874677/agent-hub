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

test('过滤：换提供商要重启进程而不是藏起来，所以全部候选都放出来', () => {
  const items = [hub('hub-a/x'), hub('hub-a/y'), hub('hub-b/z'), hub('my-codex/glm-5.3')];
  const result = filterModelsByScope(items, 'hub-a/x');
  assert.deepEqual(result.items, items);
  assert.equal(result.hidden, 0);
  assert.match(scopeNote('hub-a/x'), /重启/);
  assert.match(scopeNote('my-codex/glm-5.3'), /重启/);
  assert.deepEqual(filterModelsByScope([], 'hub-a/x'), { items: [], hidden: 0 });
});
