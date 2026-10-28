/**
 * 密钥保险箱：MCP 资产引用的密钥（`${secret:NAME}`）。适配器负责静态加密；
 * 领域层只在「会话启动 / hub 代连远端」那一刻按名字取明文，用完即弃，从不进日志、审计或界面。
 */
export interface SecretInfo {
  readonly name: string;
  readonly updatedAt: number;
}

export interface SecretVault {
  /** 只有名字和时间，没有值。 */
  list(): Promise<SecretInfo[]>;
  put(name: string, value: string, at: number): Promise<void>;
  remove(name: string): Promise<boolean>;
  /** 取明文：只返回存在的那些。 */
  reveal(names: readonly string[]): Promise<Record<string, string>>;
}
