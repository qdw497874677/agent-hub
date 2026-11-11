import type { Session } from '../session.ts';

/**
 * 会话启动时实际使用的环境版本。
 *
 * 只回答「现在应该用哪一版」，不暴露资产、MCP、密钥或任何运行时细节；
 * 什么时候重托管由 ensureHosted 决定。返回 null = 这个部署没有环境刷新能力，
 * 或这次算不出来——调用方应保持旧行为。
 */
export interface SessionEnvironmentPort {
  revision(session: Session): Promise<string | null>;
}
