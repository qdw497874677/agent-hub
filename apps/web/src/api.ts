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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
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
