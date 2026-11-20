import type { CreateServiceRequestDto, ServiceDto } from '@agent-hub/contract';
import { SERVICE_LOG_MAX } from '../../atoms/service-links.ts';
import { call, post, sq } from './http.ts';

export type { TaskDto, WorkLogEntryDto } from '@agent-hub/contract';

/**
 * 本地服务（docs/design/session-service.md §4）：托管进程 + 最后 8 KiB 日志。
 * 状态由机器回报，`stop` 的回包是「停止前读出的那一行」，别拿它覆盖列表。
 */
export interface ProcessDto {
  readonly pid: number;
  readonly ppid: number;
  readonly cmd: string;
  readonly cwd: string;
  readonly ports: readonly number[];
}

export const servicesApi = {
  listForTask: (taskId: string) =>
    call<{ services: ServiceDto[] }>(`/api/tasks/${encodeURIComponent(taskId)}/services`).then((r) => r.services),
  listForSession: (sessionId: string) =>
    call<{ services: ServiceDto[] }>(`${sq(sessionId)}/services`).then((r) => r.services),
  create: (taskId: string, body: CreateServiceRequestDto) =>
    post<{ service: ServiceDto }>(`/api/tasks/${encodeURIComponent(taskId)}/services`, body).then((r) => r.service),
  stop: (serviceId: string) =>
    post<{ service: ServiceDto }>(`/api/services/${encodeURIComponent(serviceId)}/stop`, {}).then((r) => r.service),
  /** 只取最后 `maxBytes`（默认 8 KiB）；日志不进 DTO，单独走这条路。 */
  logs: (serviceId: string, maxBytes: number = SERVICE_LOG_MAX) =>
    call<{ tail: string }>(`/api/services/${encodeURIComponent(serviceId)}/logs?maxBytes=${maxBytes}`).then((r) => r.tail),
  /** 会话工作目录下的进程（只读观测，不落库）。 */
  processes: (sessionId: string) =>
    call<{ processes: ProcessDto[] }>(`${sq(sessionId)}/processes`).then((r) => r.processes)
};
