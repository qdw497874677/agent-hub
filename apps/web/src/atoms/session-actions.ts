import { deleteSessionBlockedHint, edgeSurvivesSession, type DeleteSessionEdge, type DeleteSessionStatus } from './delete-session.ts';
import { forkBlockedHint } from './live-core.ts';

/**
 * 一条会话能做的操作：画布（卡片、会话窗口的「⋯」）和侧栏行菜单共用这一套判断。
 * 纯函数，不碰 DOM 和网络；真正发请求、改缓存在 `use-session-actions.ts`。
 *
 * 和 delete-session.ts 一样只声明需要的结构，`api.ts` 的 DTO 能直接传进来。
 */

/** 改名：连续空白并成一个、去头尾；空串表示清掉名字（回到用第一句提问当名字）。 */
export function normalizeSessionTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** 收起 / 移回活跃列表：跑着的会话先别沉，停下来再说。 */
export function settleGate(input: { readonly settled: boolean; readonly status: DeleteSessionStatus }): {
  readonly disabled: boolean;
  readonly hint: string;
} {
  if (input.settled) return { disabled: false, hint: '回到侧栏的活跃列表，随时可以再收起' };
  if (input.status === 'running') return { disabled: true, hint: '会话还在跑，停下来才能收起' };
  return { disabled: false, hint: '做完的会话移出活跃列表；画布上仍然看得到' };
}

/** 常驻开关的说明。 */
export function pinHint(pinned: boolean): string {
  return pinned ? '恢复按空闲回收' : '不按空闲回收，适合长期跑本地服务';
}

export const FORK_HINT = '从最新处开一条新会话，带着到此刻的上下文；原会话不动';
export const DELETE_HINT = '永久删除这条会话的会话记录、产物引用和连线；工作目录里的文件保留';

export type SessionActionId = 'expand' | 'interrupt' | 'rename' | 'fork' | 'settle' | 'pin' | 'delete';

export interface SessionActionItem {
  readonly id: SessionActionId;
  /** 菜单上的短标签。 */
  readonly label: string;
  /** 悬停提示：禁用时是原因。 */
  readonly hint: string;
  readonly disabled: boolean;
  readonly danger: boolean;
}

export interface SessionActionInput {
  readonly status: DeleteSessionStatus;
  readonly settled: boolean;
  readonly pinned: boolean;
  readonly lastSeq: number;
  /** 这一轮还在等回复（`waitingForReply`）：能停、不能分叉。 */
  readonly turnRunning: boolean;
  /** agent 声明不支持分叉。 */
  readonly forkDenied: boolean;
  /** 已知当前账号能不能删；不知道就不传，交给服务端判。 */
  readonly deleteAllowed?: boolean;
  /** 能不能在画布里展开（有画布的项目页才有）。 */
  readonly canExpand: boolean;
}

/**
 * 侧栏行菜单的条目（顺序即显示顺序）。「停止」只在这一轮还在跑时出现，
 * 其余条目常驻、不能用时置灰并把原因放进提示——和会话页「⋯」同一套规则。
 */
export function sessionActionItems(input: SessionActionInput): readonly SessionActionItem[] {
  const items: SessionActionItem[] = [];
  if (input.canExpand) items.push({ id: 'expand', label: '在画布中展开', hint: '多个会话并排看', disabled: false, danger: false });
  if (input.turnRunning) items.push({ id: 'interrupt', label: '停止', hint: '停下这一轮，会话保留', disabled: false, danger: false });
  items.push({ id: 'rename', label: '重命名', hint: '留空用第一句提问当名字', disabled: false, danger: false });
  const forkHint = forkBlockedHint({ lastSeq: input.lastSeq, turnRunning: input.turnRunning, denied: input.forkDenied });
  items.push({ id: 'fork', label: '分叉', hint: forkHint ?? FORK_HINT, disabled: forkHint !== null, danger: false });
  const settle = settleGate({ settled: input.settled, status: input.status });
  items.push({ id: 'settle', label: input.settled ? '移回活跃' : '收起', hint: settle.hint, disabled: settle.disabled, danger: false });
  items.push({ id: 'pin', label: input.pinned ? '取消常驻' : '设为常驻', hint: pinHint(input.pinned), disabled: false, danger: false });
  const deleteHint = deleteSessionBlockedHint({
    status: input.status,
    ...(input.deleteAllowed === undefined ? {} : { allowed: input.deleteAllowed })
  });
  items.push({ id: 'delete', label: '删除…', hint: deleteHint ?? DELETE_HINT, disabled: deleteHint !== null, danger: true });
  return items;
}

/* ---- 画布缓存的就地改写：侧栏和会话页改完立刻反应，再让外层重拉真数据 ---- */

interface CanvasLike<S extends { readonly id: string }> {
  readonly sessions: readonly S[];
  readonly edges: readonly DeleteSessionEdge[];
}

export function patchSession<C extends { readonly sessions: readonly { readonly id: string }[] }>(
  canvas: C,
  sessionId: string,
  patch: Partial<C['sessions'][number]>
): C {
  return { ...canvas, sessions: canvas.sessions.map((item) => (item.id === sessionId ? { ...item, ...patch } : item)) } as C;
}

/** 删掉一条会话：会话本身和挂在它身上的边一起摘掉。 */
export function dropSession<S extends { readonly id: string }, C extends CanvasLike<S>>(canvas: C, sessionId: string): C {
  return {
    ...canvas,
    sessions: canvas.sessions.filter((item) => item.id !== sessionId),
    edges: canvas.edges.filter((edge) => edgeSurvivesSession(edge, sessionId))
  } as C;
}

/* ---- 侧栏行菜单的位置 ---- */

/** 菜单宽度下限；每项高度按触屏 44px 估，宁可多收一点也别出屏。 */
export const MENU_WIDTH = 168;
const ITEM_HEIGHT = 44;

/** 菜单落在哪：右键用指针坐标，「⋯」用按钮左下角；都夹在视口里。 */
export function menuPosition(
  anchor: { readonly x: number; readonly y: number },
  count: number,
  viewport: { readonly width: number; readonly height: number }
): { readonly left: number; readonly top: number } {
  const height = count * ITEM_HEIGHT + 8;
  return {
    left: Math.max(4, Math.min(anchor.x, viewport.width - MENU_WIDTH - 4)),
    top: Math.max(4, Math.min(anchor.y, viewport.height - height - 4))
  };
}
