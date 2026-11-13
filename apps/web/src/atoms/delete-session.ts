import { sessionDisplayName } from './session-link-info.ts';

/**
 * 这里刻意不从 `api.ts` 取类型：本文件被单测直接 import，会落进根 tsconfig
 * （没有 DOM lib）。结构化声明必要的几个形状，`api.ts` 的 DTO 能直接传进来。
 */
export type DeleteSessionStatus = 'running' | 'stopped' | 'done' | 'interrupted' | 'failed';

/** 画布上三种边，字段与 `CanvasDto['edges'][number]` 一致。 */
export type DeleteSessionEdge =
  | { readonly kind: 'derive'; readonly sessionId: string }
  | { readonly kind: 'fork'; readonly fromSessionId: string; readonly toSessionId: string }
  | { readonly kind: 'link'; readonly aSessionId: string; readonly bSessionId: string };

/**
 * 删除会话的文案与禁用判断。纯函数，界面那一侧只管渲染。
 *
 * 和删除项目不同，这里没有「回收站」：删了就是删了，所以弹窗要把
 * 「哪些东西没了、哪些还在」说在明处。工作空间里的文件一律不动。
 */

/** 会话还在跑时那一行原因（服务端同样会回 409）。 */
export const DELETE_SESSION_RUNNING_HINT = '先停止会话再删除';
/** 已知当前账号不能删这条会话时的那行原因。 */
export const DELETE_SESSION_UNAVAILABLE_HINT = '你没有权限删除这条会话';

export interface DeleteSessionGate {
  readonly status: DeleteSessionStatus;
  /**
   * 前端已经知道能不能删（例如共享只读会话）。不知道就传 undefined：
   * 交给服务端判，403 会落到弹窗里的错误行。
   */
  readonly allowed?: boolean;
}

/** 不能删时返回要显示的那行原因；能删返回 null。 */
export function deleteSessionBlockedHint(input: DeleteSessionGate): string | null {
  // 能力层面的「不能删」排在前面：这时候停止会话也没用。
  if (input.allowed === false) return DELETE_SESSION_UNAVAILABLE_HINT;
  if (input.status === 'running') return DELETE_SESSION_RUNNING_HINT;
  return null;
}

/**
 * 弹窗里怎么称呼这条会话：和连接芯片、列表行同一套取法——
 * 起过名用名字，没起名用第一句提问（canvas.openings），都没有才「未命名会话」。
 * 不另做截断：第一句该留多长由 sessionDisplayName 的规则决定。
 */
export function deleteSessionLabel(input: {
  readonly title?: string | null;
  readonly opening?: string | null;
}): string {
  return sessionDisplayName(input.title, input.opening);
}

/** 确认框正文：说清删掉什么、留下什么，以及不能撤销。 */
export function deleteSessionBody(name: string): string {
  return `会话「${name}」的会话记录、产物引用和连线会被永久删除，工作空间里的文件保留。不能撤销。`;
}

/** 删除失败时弹窗里那行字：状态码能说清的就别把服务端原文丢给人。 */
export function deleteSessionErrorText(failure: unknown): string {
  const status = typeof (failure as { status?: unknown } | null)?.status === 'number'
    ? (failure as { status: number }).status
    : null;
  if (status === 409) return '会话还在运行，先停止再删除';
  if (status === 403) return DELETE_SESSION_UNAVAILABLE_HINT;
  if (status === 404) return '这条会话已经不在了';
  const message = failure instanceof Error ? failure.message.trim() : '';
  return message || '删除失败，请再试一次';
}

/**
 * 删掉一条会话后，这条边还该不该留在画布上。
 * 连线（link）、分叉（fork）、派生（derive）都要跟着会话一起消失，
 * 不然画布上会挂着指向空卡片的线。
 */
export function edgeSurvivesSession(edge: DeleteSessionEdge, sessionId: string): boolean {
  switch (edge.kind) {
    case 'link':
      return edge.aSessionId !== sessionId && edge.bSessionId !== sessionId;
    case 'fork':
      return edge.fromSessionId !== sessionId && edge.toSessionId !== sessionId;
    default:
      return edge.sessionId !== sessionId;
  }
}
