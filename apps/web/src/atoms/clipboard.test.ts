import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyText, type ClipboardLike } from './clipboard.ts';

test('复制：原生剪贴板可用时只写一次，内容是原样文字', async () => {
  const written: string[] = [];
  const clipboard: ClipboardLike = {
    writeText: async (text) => {
      written.push(text);
    }
  };
  assert.equal(await copyText('ahp_test_synthetic_value', clipboard), 'copied');
  assert.deepEqual(written, ['ahp_test_synthetic_value']);
});

test('复制：没有剪贴板接口时落到手动复制，不尝试假装成功', async () => {
  assert.equal(await copyText('synthetic', null), 'manual');
});

test('复制：writeText 同步抛错时落到手动复制', async () => {
  const clipboard: ClipboardLike = {
    writeText: () => {
      throw new Error('not allowed');
    }
  };
  assert.equal(await copyText('synthetic', clipboard), 'manual');
});

test('复制：writeText 被拒绝（普通 HTTP / 权限拒绝）时落到手动复制', async () => {
  const clipboard: ClipboardLike = {
    writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
  };
  assert.equal(await copyText('synthetic', clipboard), 'manual');
});

test('复制：writeText 不是函数也当作没有剪贴板', async () => {
  const clipboard = { writeText: 'nope' } as unknown as ClipboardLike;
  assert.equal(await copyText('synthetic', clipboard), 'manual');
});
