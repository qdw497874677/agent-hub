import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PreviewLinkDto } from '@agent-hub/contract';
import {
  PREVIEW_LABEL_LIMIT,
  previewAge,
  previewDraftProblem,
  previewStateLine,
  previewUrlFor,
  shareActive,
  shareHoursLabel,
  shareHoursOptions,
  shareStateText,
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
  shared: false,
  shareExpiresAt: null,
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

test('分享档位就四档，且每档都有人话', () => {
  assert.deepEqual([...shareHoursOptions], [1, 24, 72, 168]);
  assert.deepEqual(shareHoursOptions.map(shareHoursLabel), ['1 小时', '1 天', '3 天', '7 天']);
  assert.equal(shareHoursLabel(48), '2 天');
  assert.equal(shareHoursLabel(5), '5 小时');
});

test('没分享就不出声：状态行是 null', () => {
  const now = 10_000_000;
  assert.equal(shareStateText(link({ shared: false, shareExpiresAt: null }), now), null);
  assert.equal(shareStateText(link({ shared: false, shareExpiresAt: now + 3_600_000 }), now), null);
});

test('分享中：剩几小时就说几小时，不足一小时单独一句', () => {
  const now = 10_000_000;
  assert.equal(
    shareStateText(link({ shared: true, shareExpiresAt: now + 24 * 3_600_000 }), now),
    '公开分享 · 还有 24 小时'
  );
  // 23 小时 10 分：向上取整到 24，别让人以为少算了一截
  assert.equal(
    shareStateText(link({ shared: true, shareExpiresAt: now + 23 * 3_600_000 + 600_000 }), now),
    '公开分享 · 还有 24 小时'
  );
  assert.equal(shareStateText(link({ shared: true, shareExpiresAt: now + 3_600_000 }), now), '公开分享 · 还有 1 小时');
  assert.equal(shareStateText(link({ shared: true, shareExpiresAt: now + 60_000 }), now), '公开分享 · 不到 1 小时');
});

test('到期就是到期：恰好到期和早过期都是「分享已过期」', () => {
  const now = 10_000_000;
  assert.equal(shareStateText(link({ shared: true, shareExpiresAt: now }), now), '分享已过期');
  assert.equal(shareStateText(link({ shared: true, shareExpiresAt: now - 1 }), now), '分享已过期');
});

test('shared 为真但没有到期时间：不编造状态', () => {
  assert.equal(shareStateText(link({ shared: true, shareExpiresAt: null }), 1_000), null);
});

test('「公开」标签只在有效期内亮', () => {
  const now = 10_000_000;
  assert.equal(shareActive(link({ shared: true, shareExpiresAt: now + 1 }), now), true);
  assert.equal(shareActive(link({ shared: true, shareExpiresAt: now }), now), false);
  assert.equal(shareActive(link({ shared: false, shareExpiresAt: now + 60_000 }), now), false);
  assert.equal(shareActive(link({ shared: true, shareExpiresAt: null }), now), false);
});
