import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PreviewLinkDto, ServiceDto } from '@agent-hub/contract';
import {
  SERVICE_LOG_MAX,
  durationText,
  serviceAgeText,
  serviceCommandProblem,
  serviceMetaText,
  servicePortProblem,
  servicePortText,
  servicePreviewLink,
  serviceRootProblem,
  serviceStateText,
  serviceStateTone,
  sortServices
} from './service-links.ts';

const service = (over: Partial<ServiceDto> = {}): ServiceDto => ({
  id: 'svc_0000aaaa',
  projectId: 'p1',
  taskId: 't1',
  workspaceId: 'w1',
  sessionId: 's1',
  workerId: 'w1',
  root: '/tmp/work',
  command: 'npm run dev',
  port: 5173,
  env: {},
  restart: 'on-demand',
  state: 'running',
  pid: 1234,
  detail: null,
  startedAt: 1_000,
  updatedAt: 1_000,
  ...over
});

const link = (over: Partial<PreviewLinkDto>): PreviewLinkDto => ({
  id: 'pv_00000001',
  sessionId: 's1',
  workerId: 'w1',
  port: 5173,
  hubPort: 17901,
  label: 'Vite',
  source: 'detected',
  state: 'ready',
  createdAt: 1_000,
  lastSeenAt: 1_000,
  shared: false,
  shareExpiresAt: null,
  ...over
});

test('状态文案：停止中优先，机器离线盖住 running', () => {
  assert.equal(serviceStateText('running'), '运行中');
  assert.equal(serviceStateText('starting'), '启动中');
  assert.equal(serviceStateText('failed'), '失败');
  assert.equal(serviceStateText('stopped'), '已停止');
  assert.equal(serviceStateText('running', { stopping: true }), '停止中');
  assert.equal(serviceStateText('running', { offline: true }), '机器离线');
  // 已停止的服务不会因为机器离线改口
  assert.equal(serviceStateText('stopped', { offline: true }), '已停止');
});

test('状态颜色只用现有语义色', () => {
  assert.equal(serviceStateTone('running'), 'sage');
  assert.equal(serviceStateTone('starting'), 'accent');
  assert.equal(serviceStateTone('failed'), 'rust');
  assert.equal(serviceStateTone('stopped'), 'tertiary');
  assert.equal(serviceStateTone('running', { offline: true }), 'tertiary');
});

test('端口文案：没填就是自动，不显示 0 或空白', () => {
  assert.equal(servicePortText(5173), '端口 5173');
  assert.equal(servicePortText(null), '端口自动');
  assert.equal(servicePortText(undefined), '端口自动');
});

test('时长只到分钟，天以上不再算小时', () => {
  assert.equal(durationText(0), '0 秒');
  assert.equal(durationText(59_400), '59 秒');
  assert.equal(durationText(60_000), '1 分钟');
  assert.equal(durationText(3_600_000), '1 小时');
  assert.equal(durationText(4_800_000), '1 小时 20 分');
  assert.equal(durationText(90_000_000), '1 天');
});

test('运行时长：跑着的算到现在，停了的停在最后一次状态更新', () => {
  const running = service({ state: 'running', startedAt: 1_000, updatedAt: 1_000 });
  assert.equal(serviceAgeText(running, 61_000), '1 分钟');
  // 停止后 now 继续走，但数字不再涨
  const stopped = service({ state: 'stopped', startedAt: 1_000, updatedAt: 121_000 });
  assert.equal(serviceAgeText(stopped, 9_999_000), '2 分钟');
  assert.equal(serviceAgeText(service({ startedAt: null }), 1_000), null);
});

test('行上的元信息：pid 与已运行/跑了，缺项就少说一句', () => {
  assert.equal(serviceMetaText(service({ pid: 99, startedAt: 1_000, state: 'running' }), 61_000), 'pid 99 · 已运行 1 分钟');
  assert.equal(serviceMetaText(service({ pid: null, startedAt: null }), 61_000), '');
  assert.equal(
    serviceMetaText(service({ pid: 99, startedAt: 1_000, updatedAt: 121_000, state: 'failed' }), 999_000),
    'pid 99 · 跑了 2 分钟'
  );
});

test('找预览链接：先按端口，再优先同一台机器的', () => {
  const far = link({ id: 'pv_00000002', workerId: 'w2', hubPort: 17902 });
  const near = link({ id: 'pv_00000003', hubPort: 17901 });
  assert.equal(servicePreviewLink([far, near], service({ port: 5173, workerId: 'w1' }))?.id, 'pv_00000003');
  assert.equal(servicePreviewLink([far], service({ port: 5173, workerId: 'w1' }))?.id, 'pv_00000002');
  assert.equal(servicePreviewLink([near], service({ port: 3000 })), null);
  assert.equal(servicePreviewLink([link({ port: null as unknown as number })], service({ port: null })), null);
});

test('端口输入：留空可以，非数字与越界给出人话', () => {
  assert.equal(servicePortProblem(''), null);
  assert.equal(servicePortProblem('  '), null);
  assert.equal(servicePortProblem('5173'), null);
  assert.equal(servicePortProblem('5173.5'), '端口只能是数字');
  assert.equal(servicePortProblem('1023'), '端口要在 1024–65535 之间');
  assert.equal(servicePortProblem('65536'), '端口要在 1024–65535 之间');
});

test('命令与工作空间的校验', () => {
  assert.equal(serviceCommandProblem('  '), '先写要跑的命令');
  assert.equal(serviceCommandProblem('npm run dev'), null);
  assert.equal(serviceCommandProblem('x'.repeat(2001)), '命令最多 2000 个字');
  assert.equal(serviceRootProblem(''), null);
  assert.equal(serviceRootProblem('relative/path'), '工作空间要是绝对路径');
  assert.equal(serviceRootProblem('/tmp/work'), null);
});

test('列表排序：在跑的在前，其余按更新时间倒序', () => {
  const rows = sortServices([
    service({ id: 'svc_00000001', state: 'stopped', updatedAt: 500 }),
    service({ id: 'svc_00000002', state: 'running', updatedAt: 100 }),
    service({ id: 'svc_00000003', state: 'starting', updatedAt: 50 }),
    service({ id: 'svc_00000004', state: 'failed', updatedAt: 900 })
  ]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['svc_00000003', 'svc_00000002', 'svc_00000004', 'svc_00000001']
  );
});

test('日志上限就是 8 KiB', () => {
  assert.equal(SERVICE_LOG_MAX, 8192);
});
