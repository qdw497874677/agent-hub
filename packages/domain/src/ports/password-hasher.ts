/** 慢哈希。哈希串自带算法与参数，换参数后旧串仍能校验。 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}
