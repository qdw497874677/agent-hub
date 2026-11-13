import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addManualModel,
  buildProviderModels,
  draftErrors,
  draftFromModels,
  EXTRA_MAX_BYTES,
  mergePulledModels,
  removeDraft,
  setSelectedFor,
  updateDraft,
  validateExtraJson,
  parseTokenCount
} from './provider-models.ts';

test('已存模型 → 行状态：额外参数压成一行 JSON，没填的字段留空串', () => {
  const [withExtra, bare] = draftFromModels([
    { id: 'gpt-5', name: 'GPT-5', contextWindow: 128000, maxTokens: 8192, extra: { reasoning_effort: 'high' } },
    { id: 'o3' }
  ]);
  assert.deepEqual(withExtra, {
    id: 'gpt-5',
    name: 'GPT-5',
    contextWindow: '128000',
    maxTokens: '8192',
    extraText: '{"reasoning_effort":"high"}',
    selected: true,
    persisted: true,
    missing: false
  });
  assert.equal(bare?.name, '');
  assert.equal(bare?.contextWindow, '');
  assert.equal(bare?.extraText, '');
});

test('额外参数：留空合法；非法 JSON / 非对象 / 禁键 / 超长都要有中文原因', () => {
  assert.deepEqual(validateExtraJson('   '), { ok: true });
  assert.deepEqual(validateExtraJson('{"reasoning_effort":"high"}'), { ok: true, value: { reasoning_effort: 'high' } });

  const broken = validateExtraJson('{reasoning_effort: high}');
  assert.equal(broken.ok, false);
  assert.match(broken.ok ? '' : broken.error, /不是合法 JSON/);

  for (const text of ['[1,2]', 'null', '"high"']) {
    const result = validateExtraJson(text);
    assert.equal(result.ok, false, text);
    assert.match(result.ok ? '' : result.error, /JSON 对象/);
  }

  for (const key of ['model', 'messages', 'input', 'stream', 'stream_options', 'tools']) {
    const result = validateExtraJson(`{"${key}":1}`);
    assert.equal(result.ok, false, key);
    assert.match(result.ok ? '' : result.error, new RegExp(`「${key}」`));
  }

  const big = validateExtraJson(JSON.stringify({ pad: 'x'.repeat(EXTRA_MAX_BYTES) }));
  assert.equal(big.ok, false);
  assert.match(big.ok ? '' : big.error, new RegExp(`超过 ${EXTRA_MAX_BYTES} 字节`));
});

test('数字输入：可留空；填了必须是正整数', () => {
  assert.deepEqual(parseTokenCount('', '上下文长度'), { ok: true });
  assert.deepEqual(parseTokenCount(' 128000 ', '上下文长度'), { ok: true, value: 128000 });
  for (const text of ['12k', '0', '-1', '1.5', 'abc']) {
    const result = parseTokenCount(text, '上下文长度');
    assert.equal(result.ok, false, text);
  }
  const zero = parseTokenCount('0', '最大输出');
  assert.match(zero.ok ? '' : zero.error, /最大输出要大于 0/);
});

test('行校验：只报填错的字段', () => {
  const [draft] = draftFromModels([{ id: 'm' }]);
  assert.deepEqual(draftErrors({ ...draft!, extraText: '{"thinking":' }), { extra: '不是合法 JSON：检查引号、逗号和括号' });
  assert.deepEqual(draftErrors({ ...draft!, contextWindow: '1.5' }), { contextWindow: '上下文长度只能填正整数' });
  assert.deepEqual(draftErrors({ ...draft!, extraText: '{"a":1}', contextWindow: '128000', maxTokens: '8192' }), {});
});

test('拉取合并：保留用户填的字段，只补空字段；新增勾选；消失的标灰但不动', () => {
  const drafts = draftFromModels([
    { id: 'keep', name: '我起的名字', contextWindow: 64000, extra: { temperature: 0.2 } },
    { id: 'fill', name: '' },
    { id: 'gone', name: '旧模型' }
  ]);
  const merged = mergePulledModels(drafts, [
    { id: 'keep', name: '上游名字', contextWindow: 128000, maxTokens: 4096 },
    { id: 'fill', name: '上游名字', contextWindow: 32000 },
    { id: 'new', name: '新模型', maxTokens: 2048 }
  ]);

  assert.deepEqual(
    merged.map((draft) => [draft.id, draft.name, draft.contextWindow, draft.maxTokens, draft.selected, draft.missing]),
    [
      ['keep', '我起的名字', '64000', '4096', true, false],
      ['fill', '上游名字', '32000', '', true, false],
      ['new', '新模型', '', '2048', true, false],
      ['gone', '旧模型', '', '', true, true]
    ]
  );
  // 用户填的额外参数不会被拉取覆盖。
  assert.equal(merged[0]?.extraText, '{"temperature":0.2}');

  // 上游又给了：missing 清掉，勾选/删除意愿保持原样。
  const back = mergePulledModels(updateDraft(merged, 'gone', { selected: false }), [{ id: 'gone', name: '旧模型 v2' }]);
  assert.equal(back[0]?.id, 'gone');
  assert.equal(back[0]?.missing, false);
  assert.equal(back[0]?.selected, false);
  assert.equal(back[0]?.name, '旧模型');
});

test('拉取合并：手动加的行不会被标成「上游已不提供」，重复 id 只留一条', () => {
  const manual = addManualModel([], 'my-model');
  const merged = mergePulledModels(manual, [
    { id: 'upstream' },
    { id: 'upstream' }
  ]);
  assert.deepEqual(
    merged.map((draft) => [draft.id, draft.selected, draft.persisted, draft.missing]),
    [
      ['upstream', true, false, false],
      ['my-model', true, false, false]
    ]
  );
});

test('手动添加：新 id 追加并勾选；重复 id 只勾上；空串不动', () => {
  const base = addManualModel([], 'a');
  assert.equal(base.length, 1);
  const unselected = updateDraft(base, 'a', { selected: false });
  assert.equal(addManualModel(unselected, 'a')[0]?.selected, true);
  assert.equal(addManualModel(base, '  ').length, 1);
  assert.deepEqual(addManualModel(base, 'b').map((draft) => draft.id), ['a', 'b']);
});

test('全选/全不选只动传进来的行；删行按时生效', () => {
  const drafts = addManualModel(addManualModel([], 'a'), 'b');
  const picked = setSelectedFor(drafts, ['b'], false);
  assert.deepEqual(picked.map((draft) => draft.selected), [true, false]);
  assert.deepEqual(removeDraft(drafts, 'a').map((draft) => draft.id), ['b']);
});

test('保存载荷：未勾选的视为删除；额外参数解析成对象；空白字段不塞进请求', () => {
  let drafts = draftFromModels([
    { id: 'a', name: 'A', extra: { reasoning_effort: 'high' } },
    { id: 'b', name: 'B' }
  ]);
  drafts = updateDraft(drafts, 'b', { selected: false });

  const built = buildProviderModels(drafts);
  assert.deepEqual(built.errors, []);
  assert.deepEqual(built.models, [{ id: 'a', name: 'A', extra: { reasoning_effort: 'high' } }]);

  // 空对象不写进请求；数字填了才带。
  const blankExtra = buildProviderModels([
    { id: 'c', name: '', contextWindow: '128000', maxTokens: '', extraText: ' {} ', selected: true, persisted: false, missing: false }
  ]);
  assert.deepEqual(blankExtra.models, [{ id: 'c', contextWindow: 128000 }]);
});

test('保存载荷：有错的行拦下来报错，不进载荷', () => {
  const built = buildProviderModels([
    { id: 'ok', name: '', contextWindow: '', maxTokens: '', extraText: '', selected: true, persisted: false, missing: false },
    { id: 'bad', name: '', contextWindow: 'x', maxTokens: '', extraText: '{"model":"gpt-4"}', selected: true, persisted: false, missing: false },
    { id: 'skip', name: '', contextWindow: 'x', maxTokens: '', extraText: '', selected: false, persisted: true, missing: true }
  ]);
  assert.deepEqual(built.models.map((model) => model.id), ['ok']);
  assert.equal(built.errors.length, 1);
  assert.equal(built.errors[0]?.id, 'bad');
  assert.match(built.errors[0]?.errors.extra ?? '', /「model」/);
  assert.match(built.errors[0]?.errors.contextWindow ?? '', /正整数/);
});
