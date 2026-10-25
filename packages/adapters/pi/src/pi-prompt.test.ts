import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageRefusal, toPiPrompt } from './pi-runtime.ts';

test('pi prompt：图片走 images，文件与 @ 引用以绝对路径写进消息', () => {
  assert.deepEqual(toPiPrompt({ text: 'hi', parts: [] }), { type: 'prompt', message: 'hi' });
  const command = toPiPrompt({
    text: '看',
    parts: [
      { kind: 'image', name: 'a.png', mimeType: 'image/png', data: 'AAAA', path: '/w/a.png' },
      { kind: 'mention', name: 'b.ts', path: '/w/b.ts' }
    ]
  });
  assert.deepEqual(command['images'], [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
  assert.equal(command['message'], '看\n\n附带文件（请按需读取）：\n- /w/b.ts');
});

test('纯文本模型收不了图：明说而不是默默丢掉；支持图片或没报清单的放行', () => {
  const textOnly = { model: { id: 'kimi', provider: 'cliproxy', input: ['text'] } };
  assert.match(imageRefusal(textOnly, 'a.png') ?? '', /cliproxy\/kimi 只收文字.*a\.png/);
  assert.equal(imageRefusal({ model: { id: 'g', provider: 'p', input: ['text', 'image'] } }, 'a.png'), null);
  assert.equal(imageRefusal({ model: { id: 'old', provider: 'p' } }, 'a.png'), null);
  assert.equal(imageRefusal(undefined, 'a.png'), null);
});
