/**
 * Web API 客户端的传输层：cookie 身份、CSRF、错误归一，外加几个拼路径的小助手。
 * 只给 `./api/*` 里的 surface 模块用；barrel 对外只转出 ApiError / RequestFailed /
 * UNAUTHORIZED_EVENT / streamUrl 四个名字（其余仍是包内私有，和拆分前一致）。
 */
export interface ApiError {
  readonly code: string;
  readonly message: string;
}

export class RequestFailed extends Error {
  constructor(readonly status: number, readonly detail: ApiError) {
    super(detail.message);
  }
}

/**
 * 身份靠服务端下发的 httpOnly cookie，前端碰不到登录令牌。
 * 会改东西的请求要带 X-Hub-CSRF（双提交：值从非 httpOnly 的 hub_csrf cookie 读）。
 */
function csrfToken(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)hub_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1] ?? '') : '';
}

/** 任何接口回 401 都广播出去，登录闸门据此回到登录页。 */
export const UNAUTHORIZED_EVENT = 'agent-hub:unauthorized';

export const streamUrl = (): string => '/api/stream';

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET';
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(method === 'GET' ? {} : { 'x-hub-csrf': csrfToken() }),
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: ApiError } | null;
    if (response.status === 401 && !path.startsWith('/api/auth/') && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new RequestFailed(response.status, body?.error ?? { code: 'http', message: response.statusText });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const post = <T>(path: string, body: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body) });

/** 单条会话的接口前缀。 */
export const sq = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}`;

/** 组合会话把选中的成员工作空间 id 接到 git / 文件接口上；单仓不传。 */
export const withMember = (url: string, member?: string | null): string => {
  if (!member) return url;
  return `${url}${url.includes('?') ? '&' : '?'}member=${encodeURIComponent(member)}`;
};
