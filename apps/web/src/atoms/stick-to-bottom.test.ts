import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NEAR_END_PX,
  ZOOM_SLACK,
  createFollowState,
  isFollowing,
  maxScrollOf,
  nearEndOf,
  needsEndProbe,
  reachedEnd,
  transitionFollow,
  type Contact,
  type FollowAction,
  type FollowState,
  type ScrollGeometry,
  type ScrollMetrics
} from './stick-to-bottom.ts';

const VIEW = 400;
/** 1000 高的内容放进 400 高的容器：能滚 600。 */
const MAX = 600;

function geometry(scrollTop: number, scrollHeight = VIEW + MAX): ScrollGeometry {
  return { clientHeight: VIEW, scrollHeight, scrollTop };
}

function metrics(now: ScrollGeometry, before: ScrollGeometry = now, contact: Contact | null = null): ScrollMetrics {
  return { ...now, contact, previousMaxScroll: maxScrollOf(before), previousTop: before.scrollTop };
}

function intent(upward: boolean, overflow = true): FollowAction {
  return { overflow, trigger: 'wheel', type: 'scroll.intent', upward };
}

function expectDetached(state: FollowState): Extract<FollowState, { type: 'detached' }> {
  assert.equal(state.type, 'detached');
  if (state.type !== 'detached') throw new Error('预期 detached');

  return state;
}

test('只有真的到达底部才恢复跟随：差一个像素也是读者要往上看', () => {
  const away = expectDetached(transitionFollow(createFollowState(), intent(true), metrics(geometry(MAX))));
  assert.equal(away.trigger, 'wheel');
  assert.equal(away.atBottomPending, false);

  // 差 40px：旧的 NEAR_BOTTOM_PX（80）会把这里当底部，状态机不当
  assert.equal(transitionFollow(away, { type: 'scroll' }, metrics(geometry(MAX - 40), geometry(MAX))), away);
  // 差 1px 也一样，而且连对象都不换
  assert.equal(transitionFollow(away, { type: 'scroll' }, metrics(geometry(MAX - 1), geometry(MAX))), away);

  // 滚回底部才算到达
  assert.equal(transitionFollow(away, { type: 'scroll' }, metrics(geometry(MAX), geometry(MAX - 40))).type, 'following');
});

test('没有接触的上移：几个像素是浏览器补偿，大跳转算读者离开', () => {
  const following = createFollowState();

  // 内容补偿是几像素级别
  assert.equal(transitionFollow(following, { type: 'scroll' }, metrics(geometry(MAX - 3), geometry(MAX))), following);

  // 程序化滚动 / 拖滚动条 / 惯性：没有接触也会离开底部
  const jumped = expectDetached(transitionFollow(following, { type: 'scroll' }, metrics(geometry(MAX - 120), geometry(MAX))));
  assert.equal(jumped.trigger, null);

  // 手按着就相反：往上拖是读者自己的意思
  const byTouch = expectDetached(
    transitionFollow(following, { type: 'scroll' }, metrics(geometry(MAX - 120), geometry(MAX), 'touch'))
  );
  assert.equal(byTouch.trigger, 'touch');

  const byPointer = expectDetached(
    transitionFollow(following, { type: 'scroll' }, metrics(geometry(MAX - 120), geometry(MAX), 'pointer'))
  );
  assert.equal(byPointer.trigger, 'pointer');
});

test('滚轮和键盘：只有往上、且内容真能滚才离开底部', () => {
  const following = createFollowState();

  // 往下滚：本来就在底部，不用离开
  assert.equal(transitionFollow(following, intent(false), metrics(geometry(MAX))), following);
  // 内容不足一屏：没得离开
  assert.equal(transitionFollow(following, intent(true, false), metrics(geometry(0, VIEW))), following);

  assert.equal(expectDetached(transitionFollow(following, intent(true), metrics(geometry(MAX)))).trigger, 'wheel');
  assert.equal(
    expectDetached(
      transitionFollow(
        following,
        { overflow: true, trigger: 'keyboard', type: 'scroll.intent', upward: true },
        metrics(geometry(MAX))
      )
    ).trigger,
    'keyboard'
  );

  // 已经离开了：再按一次不换原因，也不制造新对象
  const away = expectDetached(transitionFollow(following, intent(true), metrics(geometry(MAX))));
  assert.equal(
    transitionFollow(
      away,
      { overflow: true, trigger: 'keyboard', type: 'scroll.intent', upward: true },
      metrics(geometry(MAX - 30))
    ),
    away
  );
});

test('缩放差的 4px 不算离开底部，但要等滚动静止再探', () => {
  const away = expectDetached(transitionFollow(createFollowState(), intent(true), metrics(geometry(MAX))));

  // 滚到离底部 3px：可能是缩放取整，记下「可能到底」，但先不恢复跟随
  const pending = expectDetached(
    transitionFollow(away, { type: 'scroll' }, metrics(geometry(MAX - ZOOM_SLACK + 1), geometry(MAX - 40)))
  );
  assert.equal(pending.atBottomPending, true);
  assert.equal(isFollowing(pending), false);

  // 手指还按着、惯性还在走：不能探（探底会写 scrollTop）
  assert.equal(needsEndProbe(pending, 'touch'), false);
  assert.equal(needsEndProbe(pending, 'momentum'), false);
  assert.equal(needsEndProbe(pending, null), true);

  // 静下来探一次：真能推到 4px 以内就算到底
  assert.equal(reachedEnd(geometry(MAX)), true);
  assert.equal(reachedEnd(geometry(MAX - ZOOM_SLACK)), true);
  assert.equal(reachedEnd(geometry(MAX - ZOOM_SLACK - 1)), false);

  assert.equal(transitionFollow(pending, { type: 'scroll.settled', atEnd: true }, metrics(geometry(MAX - 3))).type, 'following');

  // 探完还是没到底：停在原处，不再等确认
  const stillAway = expectDetached(
    transitionFollow(pending, { type: 'scroll.settled', atEnd: false }, metrics(geometry(MAX - 3)))
  );
  assert.equal(stillAway.atBottomPending, false);
  assert.equal(stillAway.trigger, 'wheel');
});

test('内容不足一屏：maxScroll <= 1 就算到底', () => {
  const short = geometry(0, VIEW);
  assert.equal(maxScrollOf(short), 0);

  const away = expectDetached(transitionFollow(createFollowState(), intent(true), metrics(geometry(0, VIEW + MAX))));

  // 内容缩到不满一屏：视图已经在那里了，恢复跟随不会把人带走
  assert.equal(transitionFollow(away, { type: 'scroll' }, metrics(short, geometry(0, VIEW + MAX))).type, 'following');
  // 本来就不溢出也一样
  assert.equal(transitionFollow(away, { type: 'scroll' }, metrics(short, short)).type, 'following');
});

test('状态没变就返回同一个对象；排队的那一帧过期了不会把读者拽回去', () => {
  const following = createFollowState();
  assert.equal(transitionFollow(following, { type: 'scroll' }, metrics(geometry(MAX - 5), geometry(MAX - 10))), following);

  const returning = transitionFollow(following, { type: 'return.start', attempt: 1 }, metrics(geometry(MAX)));
  assert.equal(returning.type, 'returning');
  assert.equal(isFollowing(returning), true);

  // 排队之后读者往上翻：状态换人，旧帧作废
  const away = expectDetached(transitionFollow(returning, intent(true), metrics(geometry(MAX - 20), geometry(MAX))));
  assert.equal(transitionFollow(away, { type: 'return.run', attempt: 1 }, metrics(geometry(MAX - 20))), away);

  // 还是同一次排队：这一帧落地，重新跟随
  assert.equal(transitionFollow(returning, { type: 'return.run', attempt: 1 }, metrics(geometry(MAX))).type, 'following');
  // 更新的一次排队让旧帧失效
  const newer = transitionFollow(returning, { type: 'return.start', attempt: 2 }, metrics(geometry(MAX)));
  assert.equal(transitionFollow(newer, { type: 'return.run', attempt: 1 }, metrics(geometry(MAX))), newer);
});

test('主动发送或回底立即恢复跟随；随后读者仍可再次离开', () => {
  const away = transitionFollow(createFollowState(), intent(true), metrics(geometry(MAX)));
  const requested = transitionFollow(away, { type: 'follow.request' }, metrics(geometry(0)));
  assert.equal(requested.type, 'following');
  assert.equal(transitionFollow(requested, intent(true), metrics(geometry(MAX - 50))).type, 'detached');
});

test('钉住的位置只让读者自己的输入放开', () => {
  const here = metrics(geometry(320));
  const anchored = transitionFollow(createFollowState(), { anchor: 320, type: 'anchor' }, here);
  assert.equal(anchored.type, 'anchored');

  // 内容变高、同一位置的滚动都不放开
  assert.equal(transitionFollow(anchored, { type: 'scroll' }, metrics(geometry(320), geometry(320))), anchored);
  // 程序化接管或读者自己动手才放开
  assert.equal(transitionFollow(anchored, { type: 'release' }, here).type, 'following');
  assert.equal(expectDetached(transitionFollow(anchored, intent(true), here)).trigger, 'wheel');
  assert.equal(
    expectDetached(transitionFollow(anchored, { type: 'scroll' }, metrics(geometry(300), geometry(320), 'touch'))).trigger,
    'touch'
  );
});

test('「回到底部」用独立的宽松阈值：24px 内收起，和贴底的 0.5px 无关', () => {
  // 差一像素：跟随判定不认（那是往上看的意图），但按钮该收起来
  assert.equal(nearEndOf(geometry(MAX - 1)), true);
  // 刚好在阈值上还算附近，越过一个像素就露出按钮
  assert.equal(nearEndOf(geometry(MAX - NEAR_END_PX)), true);
  assert.equal(nearEndOf(geometry(MAX - NEAR_END_PX - 1)), false);
  // 中间地带：状态机说「没到底」，按钮也说「还差得远」——两套判断互不影响
  assert.equal(nearEndOf(geometry(MAX - 40)), false);
  // 内容不足一屏：没有可回去的地方，永远算附近
  assert.equal(nearEndOf(geometry(0, VIEW)), true);
  assert.equal(nearEndOf({ clientHeight: VIEW, scrollHeight: VIEW + 1, scrollTop: 1 }), true);
  // 橡皮筋回弹（scrollTop 超过上限）也不该露出来
  assert.equal(nearEndOf(geometry(MAX + 12)), true);
});
