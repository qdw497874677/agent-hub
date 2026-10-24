import type {
  AgentDto,
  ArtifactDto,
  CanvasDto,
  CreateTaskRequest,
  DeriveSessionRequest,
  ForkSessionRequest,
  JournalEntryDto,
  LayoutDto,
  ProjectDto,
  SearchHitDto,
  SearchResponseDto,
  SessionDto,
  SessionEventDto,
  TaskDto,
  WorkerInfoDto
} from '@agent-hub/contract';

export type { WorkerInfoDto };

export interface ApiError {
  readonly code: string;
  readonly message: string;
}

export class RequestFailed extends Error {
  constructor(readonly status: number, readonly detail: ApiError) {
    super(detail.message);
  }
}

const TOKEN_KEY = 'agent-hub:token';

/**
 * 绑非 loopback 时服务端会要求 token，而浏览器没办法像 curl 那样带 `-H`。
 * 所以 token 从 URL 进来一次（`?token=…`），存下来、从地址栏抹掉，
 * 之后由 fetch 带 Authorization。SSE 不能设请求头，所以它走 query 参数。
 */
function bootstrapToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url.toString());
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_KEY);
}

const token = typeof window === 'undefined' ? null : bootstrapToken();

/** SSE 用：EventSource 设不了请求头，只能把 token 放查询串。 */
export const streamUrl = (): string =>
  token === null ? '/api/stream' : `/api/stream?token=${encodeURIComponent(token)}`;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: ApiError } | null;
    throw new RequestFailed(response.status, body?.error ?? { code: 'http', message: response.statusText });
  }
  return (await response.json()) as T;
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  workers: () => call<WorkerInfoDto[]>('/api/workers'),
  projects: () => call<ProjectDto[]>('/api/projects'),
  createProject: (input: { name: string; rootPath: string }) => post<ProjectDto>('/api/projects', input),
  canvas: (projectId: string) => call<CanvasDto>(`/api/projects/${projectId}/canvas`),
  createTask: (input: CreateTaskRequest) => post<TaskDto>('/api/tasks', input),
  setTaskStatus: (taskId: string, status: TaskDto['status']) =>
    call<TaskDto>(`/api/tasks/${taskId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  derive: (input: DeriveSessionRequest) => post<SessionDto>('/api/sessions/derive', input),
  fork: (input: ForkSessionRequest) => post<SessionDto>('/api/sessions/fork', input),
  prompt: (sessionId: string, text: string) => post<{ ok: true }>(`/api/sessions/${sessionId}/prompt`, { text }),
  interrupt: (sessionId: string) => post<{ ok: true }>(`/api/sessions/${sessionId}/interrupt`, {}),
  events: (sessionId: string) => call<JournalEntryDto[]>(`/api/sessions/${sessionId}/events`),
  search: (projectId: string, q: string) =>
    call<SearchResponseDto>(`/api/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}`),
  saveLayout: (projectId: string, layout: LayoutDto['positions']) =>
    call<LayoutDto>(`/api/projects/${projectId}/layout`, { method: 'PUT', body: JSON.stringify({ positions: layout }) })
};

export type {
  AgentDto,
  ArtifactDto,
  CanvasDto,
  JournalEntryDto,
  ProjectDto,
  SearchHitDto,
  SessionDto,
  SessionEventDto,
  TaskDto
};
