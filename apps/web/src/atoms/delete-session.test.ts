import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELETE_SESSION_RUNNING_HINT,
  DELETE_SESSION_UNAVAILABLE_HINT,
  deleteSessionBlockedHint,
  deleteSessionBody,
  deleteSessionErrorText,
  deleteSessionLabel,
  edgeSurvivesSession
} from './delete-session.ts';

test('禁用原因：跑着的会话先停再删；已知没权限时那句话优先', () => {
  assert.equal(deleteSessionBlockedHint({ status: 'running' }), DELETE_SESSION_RUNNING_HINT);
  // 没权限时停止会话也没用，别指一条走不通的路。
  assert.equal(deleteSessionBlockedHint({ status: 'running', allowed: false }), DELETE_SESSION_UNAVAILABLE_HINT);
  assert.equal(deleteSessionBlockedHint({ status: 'stopped', allowed: false }), DELETE_SESSION_UNAVAILABLE_HINT);
  // 其余状态都能删。
  for (const status of ['stopped', 'done', 'interrupted', 'failed'] as const) {
    assert.equal(deleteSessionBlockedHint({ status }), null);
  }
});

test('会话名：起过名用名字，没起名用第一句提问，都没有才是未命名会话', () => {
  assert.equal(deleteSessionLabel({ title: '查登录 bug', opening: '看看日志' }), '查登录 bug');
  assert.equal(deleteSessionLabel({ title: null, opening: '  看看\n日志  ' }), '看看 日志');
  // 只有空白的标题等于没起名。
  assert.equal(deleteSessionLabel({ title: '   ', opening: '第一句' }), '第一句');
  // 第一句不另做截断：留多长由 sessionDisplayName 的规则决定。
  const long = '一'.repeat(120);
  assert.equal(deleteSessionLabel({ title: null, opening: long }), long);
  assert.equal(deleteSessionLabel({ title: null, opening: undefined }), '未命名会话');
});

test('确认框正文：说清删掉什么、留下什么、不能撤销', () => {
  assert.equal(
    deleteSessionBody('查登录 bug'),
    '会话「查登录 bug」的会话记录、产物引用和连线会被永久删除，工作空间里的文件保留。不能撤销。'
  );
});

test('失败文案：409 / 403 / 404 说人能动手的话，其余用服务端或兜底', () => {
  assert.equal(
    deleteSessionErrorText(Object.assign(new Error('session is running'), { status: 409 })),
    '会话还在运行，先停止再删除'
  );
  assert.equal(
    deleteSessionErrorText(Object.assign(new Error('forbidden'), { status: 403 })),
    DELETE_SESSION_UNAVAILABLE_HINT
  );
  assert.equal(deleteSessionErrorText(Object.assign(new Error('gone'), { status: 404 })), '这条会话已经不在了');
  assert.equal(deleteSessionErrorText(new Error('数据库忙')), '数据库忙');
  assert.equal(deleteSessionErrorText(new Error('   ')), '删除失败，请再试一次');
  assert.equal(deleteSessionErrorText(null), '删除失败，请再试一次');
});

test('删掉会话后，连到它的连线 / 分叉 / 派生边都要一起没有', () => {
  const link = { kind: 'link' as const, aSessionId: 'a', bSessionId: 'b' };
  const fork = { kind: 'fork' as const, fromSessionId: 'a', toSessionId: 'b', atSeq: 3 };
  const derive = { kind: 'derive' as const, taskId: 't', sessionId: 'a' };
  assert.equal(edgeSurvivesSession(link, 'a'), false);
  assert.equal(edgeSurvivesSession(link, 'b'), false);
  assert.equal(edgeSurvivesSession(fork, 'a'), false);
  assert.equal(edgeSurvivesSession(fork, 'b'), false);
  assert.equal(edgeSurvivesSession(derive, 'a'), false);
  // 和这条会话无关的边照旧。
  assert.equal(edgeSurvivesSession(link, 'c'), true);
  assert.equal(edgeSurvivesSession(fork, 'c'), true);
  assert.equal(edgeSurvivesSession(derive, 'c'), true);
});

test('画布上真正无关的派生边（同任务的其他会话）也不动', () => {
  const derive = { kind: 'derive' as const, taskId: 't', sessionId: 'other' };
  assert.equal(edgeSurvivesSession(derive, 'a'), true);
});
