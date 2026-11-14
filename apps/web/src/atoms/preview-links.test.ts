import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PreviewLinkDto } from '@agent-hub/contract';
import {
  PREVIEW_LABEL_LIMIT,
  previewAge,
  previewDraftProblem,
  previewStateLine,
  previewUrlFor,
  sortPreviews
} from './preview-links.ts';

const link = (over: Partial<PreviewLinkDto>): PreviewLinkDto => ({
  id: 'pv_00000001',
  sessionId: 's1',
  workerId: 'w1',
  port: 5173,
  hubPort: 7879,
  label: 'Vite',
  source: 'manual',
  state: 'ready',
  createdAt: 1_000,
  lastSeenAt: 1_000,
  ...over
});

test('预览地址跟着当前页面的协议走，端口挂在主机名后', () => {
  assert.equal(previewUrlFor({ protocol: 'http:', hostname: '127.0.0.1' }, 7879), 'http://127.0.0.1:7879');
  assert.equal(previewUrlFor({ protocol: 'https:', hostname: 'hub.example.com' }, 7879), 'https://hub.example.com:7879');
  assert.equal(previewUrlFor({ protocol: 'http:', hostname: '8.213.197.187' }, 17901), 'http://8.213.197.187:17901');
});

test('端口边界：1024 与 65535 收，1023 与 65536 拒', () => {
  assert.equal(previewDraftProblem({ port: '1024', label: '' }), null);
  assert.equal(previewDraftProblem({ port: '65535', label: '' }), null);
  assert.notEqual(previewDraftProblem({ port: '1023', label: '' }), null);
  assert.notEqual(previewDraftProblem({ port: '65536', label: '' }), null);
});

test('端口必须是整数：空、小数、带字母、负数都给原因', () => {
  assert.notEqual(previewDraftProblem({ port: '   ', label: '' }), null);
  assert.notEqual(previewDraftProblem({ port: '5173.5', label: '' }), null);
  assert.notEqual(previewDraftProblem({ port: '5173abc', label: '' }), null);
  assert.notEqual(previewDraftProblem({ port: '-3000', label: '' }), null);
});

test('标签最长 60 个字，两端空白不算', () => {
  assert.equal(previewDraftProblem({ port: '5173', label: 'a'.repeat(PREVIEW_LABEL_LIMIT) }), null);
  assert.equal(previewDraftProblem({ port: '5173', label: `  ${'a'.repeat(PREVIEW_LABEL_LIMIT)}  ` }), null);
  assert.notEqual(previewDraftProblem({ port: '5173', label: 'a'.repeat(PREVIEW_LABEL_LIMIT + 1) }), null);
});

test('状态行三种都有人话', () => {
  assert.equal(previewStateLine({ state: 'ready' }), '运行中');
  assert.equal(previewStateLine({ state: 'stale' }), '服务没在跑');
  assert.equal(previewStateLine({ state: 'offline' }), '机器离线');
});

test('最近活跃：刚刚 / 分钟 / 小时，时钟偏差不出现负数', () => {
  const now = 10_000_000;
  assert.equal(previewAge(now, now - 1_000), '刚刚');
  assert.equal(previewAge(now, now - 59_000), '刚刚');
  assert.equal(previewAge(now, now - 60_000), '1 分钟前');
  assert.equal(previewAge(now, now - 59 * 60_000), '59 分钟前');
  assert.equal(previewAge(now, now - 3_600_000), '1 小时前');
  assert.equal(previewAge(now, now + 30_000), '刚刚');
});

test('按创建时间升序，且不改原数组', () => {
  const late = link({ id: 'pv_00000003', createdAt: 3_000 });
  const early = link({ id: 'pv_00000001', createdAt: 1_000 });
  const middle = link({ id: 'pv_00000002', createdAt: 2_000 });
  const input = [late, early, middle];
  assert.deepEqual(
    sortPreviews(input).map((item) => item.id),
    ['pv_00000001', 'pv_00000002', 'pv_00000003']
  );
  assert.deepEqual(input.map((item) => item.id), ['pv_00000003', 'pv_00000001', 'pv_00000002']);
});

test('同一秒建的两条也有稳定顺序', () => {
  const a = link({ id: 'pv_0000000a', createdAt: 5_000 });
  const b = link({ id: 'pv_0000000b', createdAt: 5_000 });
  assert.deepEqual(
    sortPreviews([b, a]).map((item) => item.id),
    sortPreviews([a, b]).map((item) => item.id)
  );
});
