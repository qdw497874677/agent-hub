import type { SessionEnvironmentDto } from '@agent-hub/contract';

/**
 * 「环境改过了，但这一轮还在用旧的」这条提示该不该出、出什么字。
 *
 * 只做纯判断，不碰 DOM 也不碰网络：会话页拿到接口结果后调这里。
 * 设计取向——这是正常状态，不是故障：只在真的待生效时说一句，
 * 不显示版本号、不报警、不打断阅读。
 */
export interface EnvironmentNotice {
  /** 一行字，鼠标没有、触屏也能看懂。 */
  readonly text: string;
  /** 悬停补充（桌面），说清是哪些东西变了——不依赖它也能理解。 */
  readonly detail: string;
}

const TEXT = '环境已更新 · 下一轮对话生效';
const DETAIL = '资产、MCP 或启动配置改过；这一轮仍在用旧配置，下一轮对话开始时生效。';

/**
 * `null` / 没拿到数据（还在加载、请求失败）→ 不显示，别让人以为自己漏看了什么。
 * `supported: false`（单测 / 老部署）→ 不显示：这个部署根本不追踪环境版本。
 * `pending: false` → 不显示：一切已经生效。
 */
export function environmentNotice(status: SessionEnvironmentDto | null | undefined): EnvironmentNotice | null {
  if (!status) return null;
  if (!status.supported) return null;
  if (!status.pending) return null;
  return { text: TEXT, detail: DETAIL };
}
