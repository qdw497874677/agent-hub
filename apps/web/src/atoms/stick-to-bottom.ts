/**
 * 会话区「自动贴底」的状态机：纯函数、零 DOM；DOM 接线在 use-stick-to-bottom.ts。
 *
 * 参照 anomalyco/opencode d759c548a 的 `packages/app/src/session/timeline/machine.ts`，裁到本仓库要的四个状态。
 *
 * 三条规矩，改之前先读：
 * 1. 只有真的「到达底部」才恢复跟随。差 80px 也算底部（旧的 NEAR_BOTTOM_PX）会让读者往上翻一屏后又被流式输出
 *    拽回去；差一个像素就是明确的「我要看上面」，所以只在 0.5px 以内算到底。
 * 2. 只有读者自己的手势（滚轮、触屏、按住鼠标、键盘翻页）能让视图离开底部；程序化滚动（内容变高、贴底补偿、
 *    平滑滚动）不能——把「有没有人按着」交给 DOM 层量，这里只看 contact。
 * 3. 状态没变就返回同一个对象，订阅方不用为一次普通滚动白跑一遍。
 */

/** 差多少像素算「就在底部」。刻意收紧：收起时正好钳到底，往上挪一像素就是读者要看上面。 */
export const END_EPSILON = 0.5;

/**
 * Chrome 把 scrollHeight / clientHeight 取整、却按缩放后的像素滚，所以页面缩放到 25% 时能滚到的最远处
 * 可能比 scrollHeight - clientHeight 少 4px。这 4px 不能当成「离开底部」。
 */
export const ZOOM_SLACK = 4;
/** 没有接触时，向上位移超过这么多像素才算读者离开（小位移是浏览器在补偿内容尺寸）。 */
export const UNOWNED_DETACH_PX = 24;

/** 可滚范围小于等于这个值就算没有溢出（内容不足一屏）。 */
export const MIN_OVERFLOW = 1;

/**
 * 「回到底部」按钮的宽松阈值：离底部不到这么多像素就收起按钮。
 *
 * 刻意独立于 END_EPSILON（0.5px）：那个阈值回答的是「要不要恢复跟随」，差一像素都得算离开；
 * 这个回答的是「还要不要帮读者回去」，差二十来像素时按钮只会挡住正文。两件事别共用同一个数字。
 */
export const NEAR_END_PX = 24;

/** 读者此刻与滚动区的接触。触屏松手之后还有一段惯性，那也算读者的手（只是抬起了）。 */
export type Contact = 'touch' | 'momentum' | 'pointer';

/** 视图为什么离开底部。`null` 表示不是读者走开的（调用方要求保持原位）。 */
export type DetachTrigger = 'wheel' | 'keyboard' | 'touch' | 'pointer';

export interface ScrollGeometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** 一次滚动要同时知道「改之前」和「现在」：判断是不是读者往上走，得跟上一帧比。 */
export interface ScrollMetrics extends ScrollGeometry {
  readonly previousTop: number;
  readonly previousMaxScroll: number;
  readonly contact: Contact | null;
}

export type FollowState =
  /** 跟着最新内容走，新的内容长出屏幕就把视图按到底。 */
  | { readonly type: 'following' }
  /** 已经排好一帧去贴底；`attempt` 用来作废过期的帧（排队后读者又往上翻了）。 */
  | { readonly type: 'returning'; readonly attempt: number }
  /** 停在读者放下的地方。`atBottomPending`：滚动停在离底部 4px 以内，可能其实已经到底（缩放取整），等静下来再探。 */
  | {
      readonly type: 'detached';
      readonly trigger: DetachTrigger | null;
      readonly atBottomPending: boolean;
    }
  /** 把某个位置钉住（「在这里看这条消息」）。本仓库暂时没有调用方，留成第四个状态。 */
  | { readonly type: 'anchored'; readonly anchor: number };

export type FollowAction =
  /** 挂载、换会话、重置：从跟随重新开始，并把视图按到底。 */
  | { readonly type: 'attach' }
  /** 贴底排到下一帧。 */
  | { readonly type: 'return.start'; readonly attempt: number }
  /** 那一帧真的到了；只有还是同一次排队才贴底。 */
  | { readonly type: 'return.run'; readonly attempt: number }
  /** 调用方要求保持原位（导航、选中）。 */
  | { readonly type: 'detach' }
  | { readonly type: 'anchor'; readonly anchor: number }
  /** 程序化接管：钉住的位置放开。 */
  | { readonly type: 'release' }
  /** 滚轮 / 键盘翻页。只有往上、且内容真能滚，才算读者要离开底部。 */
  | {
      readonly type: 'scroll.intent';
      readonly trigger: 'wheel' | 'keyboard';
      readonly upward: boolean;
      readonly overflow: boolean;
    }
  /** 滚动事件；几何和接触在 metrics 里。 */
  | { readonly type: 'scroll' }
  /** 滚动静止（且手指抬起）之后的确认：`atEnd` 由探底得到。 */
  | { readonly type: 'scroll.settled'; readonly atEnd: boolean };

const FOLLOWING: FollowState = Object.freeze({ type: 'following' });

const DETACHED: FollowState = Object.freeze({ trigger: null, atBottomPending: false, type: 'detached' });

export function createFollowState(): FollowState {
  return FOLLOWING;
}

export function maxScrollOf(geometry: ScrollGeometry): number {
  return geometry.scrollHeight - geometry.clientHeight;
}

export function isFollowing(state: FollowState): boolean {
  return state.type === 'following' || state.type === 'returning';
}

/** 惯性里和手指按住时别写 scrollTop：iOS 会推迟尺寸补偿，写下去反而把读者看的位置弄丢。 */
export function holdsScroll(contact: Contact | null): boolean {
  return contact === 'touch' || contact === 'momentum';
}

/** 探底会写 scrollTop（等于把还在滑的滚动按停），所以得等滚动静止、手指抬起。 */
export function needsEndProbe(state: FollowState, contact: Contact | null): boolean {
  return state.type === 'detached' && state.atBottomPending && !holdsScroll(contact);
}

/** 探底时把 scrollTop 推到的位置，交给浏览器钳到真正能到的地方。 */
export function endProbeTarget(geometry: ScrollGeometry): number {
  return geometry.scrollHeight;
}

/** 探底之后读回来的位置：缩放下差 4px 也算到底。 */
export function reachedEnd(geometry: ScrollGeometry): boolean {
  return maxScrollOf(geometry) - geometry.scrollTop <= ZOOM_SLACK;
}

/**
 * 「就在底部附近」——只给「回到底部」按钮用，不参与跟随判定。
 * 内容不足一屏时没有可翻的，也算附近（按钮不该在不需要的时候出现）。
 */
export function nearEndOf(geometry: ScrollGeometry): boolean {
  const maxScroll = maxScrollOf(geometry);

  return maxScroll <= MIN_OVERFLOW || maxScroll - geometry.scrollTop <= NEAR_END_PX;
}

/** 内容或容器尺寸变了该怎么办：贴底、等惯性结束再贴，还是别动。 */
export function contentEffect(state: FollowState, contact: Contact | null): 'snap' | 'defer' | 'idle' {
  if (!isFollowing(state)) return 'idle';

  return holdsScroll(contact) ? 'defer' : 'snap';
}

/** 有接触的向上滚动是谁的：触屏（含惯性）算手，鼠标按住算指针，什么都没按就不算读者的意思。 */
export function contactTrigger(contact: Contact | null): DetachTrigger | null {
  switch (contact) {
    case 'touch':
    case 'momentum':
      return 'touch';
    case 'pointer':
      return 'pointer';
    default:
      return null;
  }
}

/** 键盘翻页键的语义；别的键不参与贴底判定。 */
export function scrollKey(key: string): 'up' | 'down' | null {
  switch (key) {
    case 'PageUp':
    case 'ArrowUp':
    case 'Home':
      return 'up';
    case 'PageDown':
    case 'ArrowDown':
    case 'End':
      return 'down';
    default:
      return null;
  }
}

/**
 * 状态迁移。`metrics` 是「改之前」和「现在」的几何，加上读者与滚动区的接触。
 * 不涉及到的迁移直接忽略 metrics。
 */
export function transitionFollow(state: FollowState, action: FollowAction, metrics: ScrollMetrics): FollowState {
  if (action.type === 'attach') return FOLLOWING;

  if (action.type === 'anchor')
    return state.type === 'anchored' && state.anchor === action.anchor
      ? state
      : { anchor: action.anchor, type: 'anchored' };

  if (state.type === 'anchored') return releaseAnchor(state, action, metrics);

  if (action.type === 'detach') return detachedFrom(state, null, false);

  if (action.type === 'return.start')
    return state.type === 'returning' && state.attempt === action.attempt
      ? state
      : { attempt: action.attempt, type: 'returning' };

  if (action.type === 'return.run')
    return state.type === 'returning' && state.attempt === action.attempt ? FOLLOWING : state;

  if (action.type === 'scroll.intent')
    return action.upward && action.overflow && state.type !== 'detached'
      ? detachedFrom(state, action.trigger, false)
      : state;

  if (action.type === 'scroll') return scrolled(state, metrics);

  if (action.type === 'scroll.settled') return settled(state, action.atEnd, metrics.contact);

  // 其余就是「放开钉住的位置」：没有钉住的时候没有什么可放开的。
  return state;
}

/** 钉住的位置只让读者自己的输入放开；内容变高、滚动都不放开。 */
function releaseAnchor(state: FollowState, action: FollowAction, metrics: ScrollMetrics): FollowState {
  if (action.type === 'release') return FOLLOWING;

  if (action.type === 'scroll.intent') return detachedFrom(state, action.trigger, false);

  if (action.type === 'detach') return DETACHED;

  if (action.type === 'scroll') {
    const movedUp = metrics.scrollTop < metrics.previousTop - END_EPSILON;
    const trigger = contactTrigger(metrics.contact);

    return movedUp && trigger !== null ? detachedFrom(state, trigger, false) : state;
  }

  return state;
}

// 跟随靠「到达」恢复，不靠「接近」：正好滚到底、或者内容在读者已经在的位置上缩短到不溢出。
// 只是停在离底部几个像素的地方不算，否则读者「差一像素」表达的向上意图会被下一次滚动盖掉。
function scrolled(state: FollowState, metrics: ScrollMetrics): FollowState {
  const maxScroll = maxScrollOf(metrics);
  const reachedBottom =
    metrics.scrollTop > metrics.previousTop + END_EPSILON || maxScroll < metrics.previousMaxScroll;
  const movedUp = metrics.scrollTop < metrics.previousTop - END_EPSILON;

  // 内容不足一屏时没有「离开底部」这回事：scrollTop 只能是 0，恢复跟随不会把读者带到别处。
  const atEnd = maxScroll <= MIN_OVERFLOW || (reachedBottom && maxScroll - metrics.scrollTop <= END_EPSILON);

  if (state.type !== 'detached') {
    // 没有接触的向上位移：小的算浏览器补偿尺寸变化（上面的图片加载完之类），不动；
    // 大的只可能是程序化滚动、拖滚动条或惯性滚动——读者已经离开底部，必须脱离，
    // 否则下一次内容变高会把人拽回底部（scroll-bottom 用例走的就是这条）。
    const trigger = contactTrigger(metrics.contact);
    const jumped = metrics.previousTop - metrics.scrollTop >= UNOWNED_DETACH_PX;

    return !atEnd && movedUp && (trigger !== null || jumped) ? detachedFrom(state, trigger, false) : state;
  }

  if (atEnd) return FOLLOWING;

  // 探底现在会打断还在走的滚动，所以先记下「可能到底」，等静下来由 scroll.settled 确认。
  const endPending =
    reachedBottom && maxScroll - metrics.scrollTop <= ZOOM_SLACK && !(movedUp && metrics.contact !== null)
      ? true
      : metrics.scrollTop < metrics.previousTop
        ? false
        : state.atBottomPending;

  return detachedFrom(state, state.trigger, endPending);
}

function settled(state: FollowState, atEnd: boolean, contact: Contact | null): FollowState {
  if (state.type !== 'detached' || !state.atBottomPending) return state;

  // 手指还按着、惯性还在走：等它们结束（DOM 层会在静止后才发这个动作）。
  if (holdsScroll(contact)) return state;

  return atEnd ? FOLLOWING : detachedFrom(state, state.trigger, false);
}

// 同样的状态返回同一个对象：普通滚动不制造新对象，订阅方不用白跑一遍。
function detachedFrom(
  state: FollowState | null,
  trigger: DetachTrigger | null,
  atBottomPending: boolean
): FollowState {
  if (state?.type === 'detached' && state.trigger === trigger && state.atBottomPending === atBottomPending) return state;

  return trigger === null && !atBottomPending ? DETACHED : { atBottomPending, trigger, type: 'detached' };
}
