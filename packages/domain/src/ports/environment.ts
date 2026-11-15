import type { Session } from '../session.ts';
import type { SessionAssetUpgrade } from '../asset.ts';
import type { WorkerCommand } from './node-gateway.ts';

/** 环境准备的产物：可能被改写的指令 + 这次应用的环境版本。 */
export interface PreparedStart {
  readonly command: WorkerCommand;
  readonly revision: string | null;
  /**
   * 环境展开失败（#223）：这次不允许下发。
   * 调用方应当把这条消息当成启动失败转告用户，而不是拿回原命令按「机器上装着的全给」下发。
   */
  readonly blocked?: string;
}

/**
 * 会话环境（资产/技能/MCP/工具令牌）的唯一出口。
 * - prepare：下发前改写 start_session（给 Worker 带上资产与 MCP 启动配置）；
 * - revision：只算版本，供 ensureHosted 判断是否需要重新托管。
 * 实现放在 server（需要资产库、工具令牌与网关），domain 只认接口。
 */
export interface EnvironmentPlanner {
  prepare(command: WorkerCommand): Promise<PreparedStart>;
  revision(session: Session): Promise<string | null>;
  /**
   * #226 P2：显式升级本会话的资产快照。没有快照（从未真正启动过）返回 null。
   * 升级只改快照；下一次 ensureHosted 发现 revision 变化后才会重新托管。
   */
  upgrade?(session: Session): Promise<SessionAssetUpgrade | null>;
}
