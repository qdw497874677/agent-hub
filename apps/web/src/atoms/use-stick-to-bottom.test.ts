/**
 * 这里测「接线策略」：DOM 层拿不定主意的地方，都收敛在 stick-to-bottom.ts 的纯函数里。
 * hook 本身（事件监听、rAF、观察者）需要真实 DOM 和浏览器滚动，node --test 跑不了，留给浏览器 E2E。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ZOOM_SLACK,
  contentEffect,
  createFollowState,
  endProbeTarget,
  holdsScroll,
  maxScrollOf,
  nextFollowReserve,
  needsBottomSnap,
  needsEndProbe,
  reachedEnd,
  scrollKey,
  transitionFollow,
  type Contact,
  type FollowState,
  type ScrollGeometry,
  type ScrollMetrics
} from './stick-to-bottom.ts';

const VIEW = 400;
/** 1000 高的内容放进 400 高的容器：能滚 600。 */
const MAX = 600;

test('贴底只在离实际滚动上限超过半像素时写入，不用宽松的按钮阈值', () => {
  assert.equal(needsBottomSnap(geometry(MAX)), false);
  assert.equal(needsBottomSnap(geometry(MAX - 0.5)), false);
  assert.equal(needsBottomSnap(geometry(MAX - 1)), true);
  assert.equal(needsBottomSnap(geometry(MAX + 12)), false);
  assert.equal(needsBottomSnap(geometry(0, VIEW - 20)), false);
});

test('跟随时尾部补偿收缩，后续增长逐步消耗补偿且最多保留 96px', () => {
  assert.equal(nextFollowReserve(1000, 966, 0), 34);
  assert.equal(nextFollowReserve(966, 986, 34), 14);
  assert.equal(nextFollowReserve(986, 1100, 14), 0);
  assert.equal(nextFollowReserve(1000, 700, 0), 96);
  assert.equal(nextFollowReserve(700, 680, 96), 96);
});

function geometry(scrollTop: number, scrollHeight = VIEW + MAX): ScrollGeometry {
  return { clientHeight: VIEW, scrollHeight, scrollTop };
}

function metrics(now: ScrollGeometry, before: ScrollGeometry = now, contact: Contact | null = null): ScrollMetrics {
  return { ...now, contact, previousMaxScroll: maxScrollOf(before), previousTop: before.scrollTop };
}

function scrollBy(state: FollowState, from: number, to: number, contact: Contact | null = null): FollowState {
  return transitionFollow(state, { type: 'scroll' }, metrics(geometry(to), geometry(from), contact));
}

function detachWithWheel(state: FollowState): FollowState {
  return transitionFollow(state, { overflow: true, trigger: 'wheel', type: 'scroll.intent', upward: true }, metrics(geometry(MAX)));
}

test('内容或容器尺寸变了：跟随就贴底，离开就不抢，惯性里等一等', () => {
  const following = createFollowState();
  assert.equal(contentEffect(following, null), 'snap');
  // 鼠标按住时内容变高：直接补，读者没在滚
  assert.equal(contentEffect(following, 'pointer'), 'snap');
  // 触屏按着 / iOS 惯性：别写 scrollTop，等它停下来
  assert.equal(contentEffect(following, 'touch'), 'defer');
  assert.equal(contentEffect(following, 'momentum'), 'defer');
  assert.equal(holdsScroll('touch'), true);
  assert.equal(holdsScroll('momentum'), true);
  assert.equal(holdsScroll('pointer'), false);
  assert.equal(holdsScroll(null), false);

  const returning = transitionFollow(following, { attempt: 1, type: 'return.start' }, metrics(geometry(MAX)));
  assert.equal(contentEffect(returning, null), 'snap');
  assert.equal(contentEffect(returning, 'momentum'), 'defer');

  const away = detachWithWheel(following);
  assert.equal(contentEffect(away, null), 'idle');
  assert.equal(contentEffect(away, 'touch'), 'idle');

  const anchored = transitionFollow(following, { anchor: 320, type: 'anchor' }, metrics(geometry(320)));
  assert.equal(contentEffect(anchored, null), 'idle');
});

test('探底要等滚动静止：先记「可能到底」，静下来才写 scrollTop', () => {
  // 读者往下滚到离底部 3px 就停了：这可能是缩放取整，先记「可能到底」
  const pending = scrollBy(detachWithWheel(createFollowState()), MAX - 40, MAX - ZOOM_SLACK + 1);
  assert.equal(pending.type, 'detached');
  if (pending.type !== 'detached') throw new Error('预期 detached');
  assert.equal(pending.atBottomPending, true);

  // 手指还按着 / 惯性还走着：不能探（探底会写 scrollTop，把滚动按停）
  assert.equal(needsEndProbe(pending, 'touch'), false);
  assert.equal(needsEndProbe(pending, 'momentum'), false);
  // 盲目探底用一个越界的目标，交给浏览器钳到真正能到的地方
  assert.equal(endProbeTarget(geometry(MAX - 3)), VIEW + MAX);

  // 静下来之后：读回来的位置在 4px 以内就算真的到底
  assert.equal(reachedEnd(geometry(MAX)), true);
  assert.equal(reachedEnd(geometry(MAX - ZOOM_SLACK)), true);
  assert.equal(reachedEnd(geometry(MAX - ZOOM_SLACK - 1)), false);

  assert.equal(
    transitionFollow(pending, { type: 'scroll.settled', atEnd: true }, metrics(geometry(MAX))).type,
    'following'
  );
});

test('键盘翻页键：只有往上的翻页才算读者要离开底部', () => {
  assert.equal(scrollKey('PageUp'), 'up');
  assert.equal(scrollKey('ArrowUp'), 'up');
  assert.equal(scrollKey('Home'), 'up');
  assert.equal(scrollKey('PageDown'), 'down');
  assert.equal(scrollKey('ArrowDown'), 'down');
  assert.equal(scrollKey('End'), 'down');
  assert.equal(scrollKey('p'), null);
  assert.equal(scrollKey('Escape'), null);

  const following = createFollowState();
  const up = scrollKey('PageUp');
  const down = scrollKey('PageDown');
  assert.ok(up !== null && down !== null);

  const away = transitionFollow(
    following,
    { overflow: true, trigger: 'keyboard', type: 'scroll.intent', upward: up === 'up' },
    metrics(geometry(MAX))
  );
  assert.equal(away.type, 'detached');

  // 往下翻页不会让视图离开底部（本来就在底，翻也没处翻）
  assert.equal(
    transitionFollow(
      following,
      { overflow: true, trigger: 'keyboard', type: 'scroll.intent', upward: down === 'up' },
      metrics(geometry(MAX))
    ),
    following
  );
});

interface Session {
  top: number;
  height: number;
  contact: Contact | null;
  state: FollowState;
}

function createSession(): Session {
  return { contact: null, height: VIEW + MAX, state: createFollowState(), top: MAX };
}

/** 读者（或浏览器）把视图挪到某个位置。 */
function scrollTo(session: Session, top: number): void {
  session.state = transitionFollow(
    session.state,
    { type: 'scroll' },
    metrics(geometry(top, session.height), geometry(session.top, session.height), session.contact)
  );
  session.top = top;
}

/** 内容长高：只有状态机说「贴底」时才写 scrollTop。 */
function grow(session: Session, by: number): void {
  const effect = contentEffect(session.state, session.contact);
  session.height += by;
  if (effect === 'snap') session.top = session.height - VIEW;

  // 贴底之后浏览器会补一个 scroll 事件，状态机要靠它记住新位置
  scrollTo(session, session.top);
}

test('一段完整的读会话过程：离开之后内容继续长也不抢，滚回底部才重新跟随', () => {
  const session = createSession();

  grow(session, 200); // 流式输出：跟着贴底
  assert.equal(session.state.type, 'following');
  assert.equal(session.top, 800);

  // 读者往上翻：滚轮 + 位移
  session.state = transitionFollow(
    session.state,
    { overflow: true, trigger: 'wheel', type: 'scroll.intent', upward: true },
    metrics(geometry(session.top, session.height))
  );
  assert.equal(session.state.type, 'detached');
  scrollTo(session, 500);

  // 输出还在继续：视图停在读者看的地方
  grow(session, 400);
  assert.equal(session.top, 500);
  assert.equal(session.state.type, 'detached');

  // 读者往下翻回底部：重新跟随
  scrollTo(session, maxScrollOf(geometry(0, session.height)));
  assert.equal(session.state.type, 'following');

  grow(session, 100);
  assert.equal(session.top, session.height - VIEW);
});
