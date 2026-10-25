/** 领域错误的种类。适配器边界负责把厂商异常翻译成它。 */
export type DomainErrorCode =
  | 'invalid' // 输入不合法（用户可修正）
  | 'conflict' // 当前状态不允许这个动作
  | 'not_found'
  | 'forbidden' // 身份对了但没这个权限
  | 'unavailable' // 依赖不在线（进程死了、目录没了）
  | 'not_implemented'; // 端口在、实现空

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
}

export const invalid = (message: string): DomainError => ({ code: 'invalid', message });
export const conflict = (message: string): DomainError => ({ code: 'conflict', message });
export const forbidden = (message: string): DomainError => ({ code: 'forbidden', message });
export const notFound = (message: string): DomainError => ({ code: 'not_found', message });
export const unavailable = (message: string): DomainError => ({ code: 'unavailable', message });
export const notImplemented = (capability: string): DomainError => ({
  code: 'not_implemented',
  message: `未实现：${capability}`
});
