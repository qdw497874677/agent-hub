import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeModelExtra } from './provider-proxy.ts';

const enc = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const dec = (value: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(value));
const json = (value: string | null = 'application/json') => ({ get: (name: string) => (name.toLowerCase() === 'content-type' ? value : null) });
const request = (body: unknown, options: { method?: string; subpath?: string; contentType?: string | null } = {}) => ({
  method: options.method ?? 'POST',
  subpath: options.subpath ?? '/v1/chat/completions',
  headers: json(options.contentType === undefined ? 'application/json' : options.contentType),
  body: enc(body)
});
const models = [{ id: 'm-1', extra: { temperature: 0.2, reasoning: { effort: 'low' } } }, { id: 'm-2' }];

test('命中：顶层浅合并，body 里的同名键被 extra 覆盖', () => {
  const out = mergeModelExtra(request({ model: 'm-1', temperature: 0.9, stream: true, messages: [{ role: 'user', content: 'hi' }] }), models);
  const body = dec(out) as Record<string, unknown>;
  assert.equal(body['temperature'], 0.2);
  assert.equal(body['stream'], true);
  assert.deepEqual(body['reasoning'], { effort: 'low' });
  assert.deepEqual(body['messages'], [{ role: 'user', content: 'hi' }]);
  assert.equal(body['model'], 'm-1');
});

test('hub-<slug>/ 前缀也能对上该 provider 的模型', () => {
  const out = mergeModelExtra(request({ model: 'hub-gw/m-1' }), models);
  assert.equal((dec(out) as Record<string, unknown>)['temperature'], 0.2);
});

test('未命中 / 不该改的情况原样返回同一份 body', () => {
  const cases = [
    request({ model: 'm-2' }), // 没有 extra
    request({ model: 'other' }), // 模型不在列表里
    request({ model: 'm-1' }, { method: 'GET' }),
    request({ model: 'm-1' }, { subpath: '/v1/models' }),
    request({ model: 'm-1' }, { contentType: 'text/plain' }),
    request({ model: 'm-1' }, { contentType: null }),
    request('not json at all'),
    request([{ model: 'm-1' }]),
    request({ model: 42 })
  ];
  for (const input of cases) assert.equal(mergeModelExtra(input, models), input.body);
  assert.equal(mergeModelExtra(request({ model: 'm-1' }), undefined).byteLength > 0, true);
});

test('extra 里的保护键绝不覆盖请求体', () => {
  const guarded = [{ id: 'm', extra: { model: 'x', messages: [], input: 1, stream: true, stream_options: {}, tools: [], temperature: 0.1 } }];
  const body = dec(mergeModelExtra(request({ model: 'm', messages: [{ role: 'user' }], stream: false }), guarded)) as Record<string, unknown>;
  assert.equal(body['model'], 'm');
  assert.deepEqual(body['messages'], [{ role: 'user' }]);
  assert.equal(body['stream'], false);
  assert.equal('input' in body, false);
  assert.equal('stream_options' in body, false);
  assert.equal('tools' in body, false);
  assert.equal(body['temperature'], 0.1);
});

test('思考强度：agent 已经报了值就以 agent 为准，配置只当默认值', () => {
  const thinking = [{ id: 'm', extra: { reasoning_effort: 'high', thinking: { type: 'enabled' }, temperature: 0.3 } }];
  const withAgent = dec(
    mergeModelExtra(request({ model: 'm', reasoning_effort: 'low', thinking: { type: 'disabled' } }), thinking)
  ) as Record<string, unknown>;
  assert.equal(withAgent['reasoning_effort'], 'low');
  assert.deepEqual(withAgent['thinking'], { type: 'disabled' });
  assert.equal(withAgent['temperature'], 0.3);

  const withoutAgent = dec(mergeModelExtra(request({ model: 'm' }), thinking)) as Record<string, unknown>;
  assert.equal(withoutAgent['reasoning_effort'], 'high');
  assert.deepEqual(withoutAgent['thinking'], { type: 'enabled' });
});

test('query 串不影响路径匹配', () => {
  const out = mergeModelExtra(request({ model: 'm-1' }, { subpath: '/v1/chat/completions?x=1' }), models);
  assert.equal((dec(out) as Record<string, unknown>)['temperature'], 0.2);
});
