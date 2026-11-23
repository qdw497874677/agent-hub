import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampListWidth, compareScope, crumbs, decodeText, filesErrorText, filesRefetch, humanSize, languageOf, parentOf, readListWidth, shortPath, touches, watchPaths } from './files-core.ts';

test('只有写明不在线的 503 才收成机器离线', () => {
  assert.equal(filesErrorText(503, 'Worker「e2e」不在线'), '机器离线');
  assert.equal(filesErrorText(503, '请求太频繁，稍后再试'), '请求太频繁，稍后再试');
  assert.equal(filesErrorText(503, 'Worker「e2e」没有及时回复改动列表'), 'Worker「e2e」没有及时回复改动列表');
  assert.equal(filesErrorText(503, 'worker 通道尚未就绪'), 'worker 通道尚未就绪');
  assert.equal(filesErrorText(503, '目录不存在：/tmp/x'), '目录不存在：/tmp/x');
  assert.equal(filesErrorText(503, undefined), '');
  assert.equal(filesErrorText(400, '路径不合法'), '路径不合法');
});

test('目录列表的刷新会取消进行中的旧请求，diff 不会', () => {
  assert.equal(filesRefetch('list').cancelRefetch, true);
  assert.equal(filesRefetch('diff').cancelRefetch, false);
  assert.equal(filesRefetch('changes').cancelRefetch, false);
  assert.equal(filesRefetch('read').cancelRefetch, false);
});

test('面包屑 / 父目录', () => {
  assert.deepEqual(crumbs('a/b').map((c) => c.path), ['', 'a', 'a/b']);
  assert.deepEqual(crumbs(''), [{ name: '根目录', path: '' }]);
  assert.equal(parentOf('a/b/c.ts'), 'a/b');
  assert.equal(parentOf('c.ts'), '');
});

test('根路径的紧凑写法：放得下给全文，放不下留末尾几段', () => {
  assert.equal(shortPath('/tmp/x', 32), '/tmp/x');
  assert.equal(shortPath('/home/qdw/Projects/workspace/agent-hub', 120), '/home/qdw/Projects/workspace/agent-hub');
  assert.equal(shortPath('/home/qdw/Projects/workspace/agent-hub', 32), '…/Projects/workspace/agent-hub');
  assert.ok(shortPath('/home/qdw/Projects/workspace/agent-hub', 26).length <= 26);
  // 一段就超预算时也保留它（交给 CSS 截断），不能返回空串
  assert.equal(shortPath('/tmp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 12), '…/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(shortPath('/tmp/x/', 3), '…/x');
});

test('语言 / 大小 / 解码', () => {
  assert.equal(languageOf('src/a.tsx'), 'tsx');
  assert.equal(languageOf('Dockerfile'), 'dockerfile');
  assert.equal(languageOf('LICENSE'), null);
  assert.equal(humanSize(2048), '2.0 KB');
  assert.equal(decodeText(Buffer.from('你好').toString('base64')), '你好');
});

test('订阅点：去重、含打开的文件、封顶 200；变化命中目录', () => {
  assert.deepEqual(watchPaths(['', 'src', 'src'], 'src/a.ts'), ['', 'src', 'src/a.ts']);
  assert.equal(watchPaths(Array.from({ length: 300 }, (_, i) => `d${i}`), null).length, 200);
  assert.ok(touches('src', ['src/a.ts']));
  assert.ok(!touches('src', ['src/x/a.ts']));
  assert.ok(touches('', ['a.ts']));
});

test('缓存只在没出错时给出（离线不冒充当前）', async () => {
  const { shown, FILES_QUERY } = await import('./files-core.ts');
  assert.deepEqual(shown({ data: [1], error: null }), [1]);
  assert.equal(shown({ data: [1], error: new Error('503') }), undefined);
  assert.equal(shown({ data: undefined, error: null }), undefined);
  assert.equal(FILES_QUERY.staleTime, 0);
  assert.ok(FILES_QUERY.gcTime > 0);
});

test('改动范围的说明说清在比什么，不冒充任意 Git 版本', () => {
  // 前三者是「工作树 vs 某个提交」：提交里没有的未提交/未跟踪改动也在内。
  assert.deepEqual(compareScope('head'), { detail: '工作树 vs 当前 HEAD', note: '含未提交改动', unknown: false });
  assert.deepEqual(compareScope('session', { commit: '0123456789abcdef' }), {
    detail: '工作树 vs 会话起点 01234567',
    note: '含未提交改动',
    unknown: false
  });
  // 会话起点没记录：后端会退回 HEAD，正文不能继续说是会话起点。
  const base = compareScope('session', { commit: null, sessionBase: null });
  assert.equal(base.unknown, true);
  assert.match(base.detail, /会话起点未记录/);
  // 分支范围是默认分支的 merge-base，叫「分支起点」而不是分支最新。
  assert.deepEqual(compareScope('branch', { branch: 'main', commit: 'abcdef0123' }), {
    detail: '工作树 vs 分支起点 abcdef01（main）',
    note: '含未提交改动',
    unknown: false
  });
  const noBranch = compareScope('branch', { branch: null });
  assert.equal(noBranch.unknown, true);
  assert.match(noBranch.detail, /没有可对比的默认分支/);
  // 回合是两个快照，不是工作树；这一轮没收尾时坦白是工作树。
  assert.deepEqual(compareScope('turn:3', { turn: 3, commit: '11111111', target: '22222222' }), {
    detail: '第 3 轮的两个快照（11111111 → 22222222）',
    note: '之后的改动不在内',
    unknown: false
  });
  assert.deepEqual(compareScope('turn', { turn: 2, commit: '11111111', target: null }), {
    detail: '第 2 轮开始前 vs 当前工作树',
    note: '这一轮还没结束',
    unknown: false
  });
  assert.equal(compareScope('turn', { turnNumber: 4, commit: '11111111', target: '22222222' }).detail.startsWith('第 4 轮'), true);
  assert.equal(compareScope('turn', { turn: null }).unknown, true);
  // 读改动之前就要能显示范围：不知道 sha 时不编造。
  assert.equal(compareScope('branch', { branch: 'main' }).detail, '工作树 vs 分支起点（main）');
});

test('文件列表宽度：夹在 220–720，脏值回落默认 320', () => {
  assert.equal(clampListWidth(100), 220);
  assert.equal(clampListWidth(5000), 720);
  assert.equal(clampListWidth(361.4), 361);
  assert.equal(clampListWidth(Number.NaN), 320);
  assert.equal(readListWidth(null), 320);
  assert.equal(readListWidth(''), 320);
  assert.equal(readListWidth('abc'), 320);
  assert.equal(readListWidth('0'), 320);
  assert.equal(readListWidth('480'), 480);
  assert.equal(readListWidth('900'), 720);
});
