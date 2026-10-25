import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPiPrompt } from './pi-runtime.ts';

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
