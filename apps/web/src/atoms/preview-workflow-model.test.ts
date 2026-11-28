import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PreviewWorkflowTarget } from '../shell/api/preview-types.ts';
import { diagnosticTargetIdentity, diagnosticText, previewFeedbackPath, safePreviewUrl, serviceWorkflowTargets, transportLimited, workflowTargetUrl } from './preview-workflow-model.ts';

const target = (over: Partial<PreviewWorkflowTarget> = {}): PreviewWorkflowTarget => ({
  port: 5173, workerId: 'w1', label: '前端', linkId: 'p1', url: 'http://preview.example:9000/', mapping: 'ready', ...over
});

test('预览只接受显式的 HTTP(S) URL，不接受凭据或相对地址', () => {
  assert.equal(safePreviewUrl('http://preview.example:9000'), 'http://preview.example:9000/');
  for (const url of ['javascript:alert(1)', '//example.com', '/preview', 'https://user:pass@example.com']) assert.equal(safePreviewUrl(url), null);
  assert.equal(workflowTargetUrl(target({ mapping: 'pending' })), null);
  assert.equal(workflowTargetUrl(target({ linkId: null })), null);
});

test('本地服务匹配必须同时满足机器与端口', () => {
  const matching = target();
  assert.deepEqual(serviceWorkflowTargets([matching, target({ workerId: 'w2' }), target({ port: 3000 })], 5173, 'w1'), [matching]);
});

test('诊断身份只在链接、机器、端口或映射变化时失效', () => {
  const identity = diagnosticTargetIdentity(target());
  assert.equal(diagnosticTargetIdentity(target({ label: '重命名' })), identity);
  for (const change of [{ linkId: 'p2' }, { workerId: 'w2' }, { port: 3000 }, { mapping: 'pending' as const }, { url: 'http://other.example/' }]) {
    assert.notEqual(diagnosticTargetIdentity(target(change)), identity);
  }
});

test('检查结果只陈述证据，不把超时说成服务停止', () => {
  assert.equal(diagnosticText({ state: 'timeout', status: null, checkedAt: 1 }), '检查超时，未能确认');
  assert.equal(diagnosticText({ state: 'response', status: 503, checkedAt: 1 }), '页面返回 HTTP 503');
  assert.equal(diagnosticText({ state: 'refused', status: null, checkedAt: 1 }), '预览目标拒绝连接');
});

test('反馈仅保留相对路径，剥除查询和片段', () => {
  assert.equal(previewFeedbackPath('/page?token=secret#detail'), '/page');
  for (const path of ['https://example.com/', '//example.com/', '/\\example.com/', 'page']) assert.equal(previewFeedbackPath(path), null);
});

test('HTTPS Hub 的 HTTP 入口必须说明认证限制', () => {
  assert.equal(transportLimited('https:', 'http://example.com:1234/'), true);
  assert.equal(transportLimited('http:', 'http://example.com:1234/'), false);
  assert.equal(transportLimited('https:', 'https://example.com/'), false);
});
