import type { ProjectId, ServiceId, SessionId, TaskId, WorkspaceId } from './ids.ts';
import { previewPortProblem } from './preview.ts';

/**
 * 会话服务（docs/design/session-service.md）：由 hub 记账、Worker 执行的一条长驻命令。
 *
 * `state` 只由 Worker 上报推进——hub 从不乐观地写 running，否则会出现「界面说在跑、进程已经死了」。
 */

export const SERVICE_COMMAND_MAX = 2000;
/** 单条服务最多带这么多个环境变量。 */
export const SERVICE_ENV_MAX = 20;
/** 单个环境变量值的上限（与契约里的字符串上限对齐）。 */
export const SERVICE_ENV_VALUE_MAX = 4000;
/** 日志尾部最多留这么多字节（Worker 与 hub 两边一致）。 */
export const SERVICE_LOG_MAX = 8 * 1024;

/** 这些变量是 hub / worker 自己的凭据，服务命令与环境变量都不许碰（验收 4）。 */
export const SERVICE_ENV_DENIED: readonly string[] = ['HUB_TOKEN', 'HUB_WORKER_CREDENTIAL', 'HUB_LOCAL_SECRET'];

export type ServiceRestart = 'always' | 'on-demand' | 'never';
export type ServiceState = 'starting' | 'running' | 'failed' | 'stopped';

export interface SessionService {
  readonly id: ServiceId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId | null;
  readonly workspaceId: WorkspaceId | null;
  /** 从哪条会话发起（可空）。 */
  readonly sessionId: SessionId | null;
  readonly workerId: string;
  /** 绝对路径，必须在 WORKER_ROOTS 内（由 Worker realpath 后判定）。 */
  readonly root: string;
  /** 交给 `/bin/sh -lc` 执行的命令。 */
  readonly command: string;
  /** 1024–65535；null = 未声明端口。 */
  readonly port: number | null;
  readonly env: Readonly<Record<string, string>>;
  readonly restart: ServiceRestart;
  readonly state: ServiceState;
  readonly pid: number | null;
  /** failed 的原因；stopped 的退出码说明。 */
  readonly detail: string | null;
  /** 尾部日志（最多 8 KiB）：Worker 重启后 hand 上还看得到上次的输出。 */
  readonly logTail: string;
  readonly startedAt: number | null;
  readonly updatedAt: number;
}

/** 服务 id 的生成形：`svc_<8hex>`。 */
export const serviceIdFrom = (hex: string): ServiceId => `svc_${hex}` as ServiceId;

const DENIED_PATTERN = new RegExp(`\\b(?:${SERVICE_ENV_DENIED.join('|')})\\b`);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 命令为空 / 太长 / 带 hub 凭据名都不行。返回 null = 可以。 */
export function serviceCommandProblem(command: string): string | null {
  const text = command.trim();
  if (text === '') return '命令不能为空';
  if (text.length > SERVICE_COMMAND_MAX) return `命令最多 ${SERVICE_COMMAND_MAX} 个字符`;
  const denied = DENIED_PATTERN.exec(text);
  if (denied !== null) return `命令里不能出现 hub 的凭据变量（${denied[0]}）`;
  return null;
}

/** 环境变量：≤20 个、键名合法、值不太长、不许碰凭据。返回 null = 可以。 */
export function serviceEnvProblem(env: Readonly<Record<string, string>>): string | null {
  const entries = Object.entries(env);
  if (entries.length > SERVICE_ENV_MAX) return `环境变量最多 ${SERVICE_ENV_MAX} 个`;
  for (const [key, value] of entries) {
    if (!ENV_KEY.test(key)) return `环境变量名不合法：${key}`;
    if (SERVICE_ENV_DENIED.includes(key)) return `环境变量 ${key} 不能由服务设置`;
    if (value.length > SERVICE_ENV_VALUE_MAX) return `环境变量 ${key} 的值太长（最多 ${SERVICE_ENV_VALUE_MAX} 个字符）`;
  }
  return null;
}

/** 端口：null = 未声明；否则沿用预览端口的语义（1024–65535）。 */
export function servicePortProblem(port: number | null): string | null {
  if (port === null) return null;
  return previewPortProblem(port);
}

export interface ServiceStateReport {
  readonly state: ServiceState;
  /** 毫秒时间戳；由调用方给，保持纯函数。 */
  readonly at: number;
  readonly pid?: number | null;
  readonly detail?: string | null;
  readonly port?: number | null;
}

/**
 * Worker 上报的状态 → 新的服务记录（纯函数）。
 *
 * - `running` / `starting` 记住 pid；其余状态清掉（进程没了）。
 * - `failed` / `stopped` 记住 detail；回到 running 时清空。
 * - `startedAt` 只在第一次进入 running 时落，重启重拉不会把「什么时候开始跑的」抹掉。
 */
export function serviceStateOf(service: SessionService, report: ServiceStateReport): SessionService {
  const alive = report.state === 'running' || report.state === 'starting';
  const pid = alive ? report.pid ?? service.pid : null;
  const detail = report.state === 'failed' || report.state === 'stopped' ? report.detail ?? service.detail : null;
  const startedAt = report.state === 'running' ? service.startedAt ?? report.at : service.startedAt;
  return {
    ...service,
    state: report.state,
    pid,
    detail,
    startedAt,    port: report.port === undefined ? service.port : report.port,
    updatedAt: report.at
  };
}

/** 追加一段日志并只留尾部 `SERVICE_LOG_MAX` 字节（按字符切，中文可能多留一点，够用）。 */
export function appendServiceLog(tail: string, chunk: string): string {
  const next = tail + chunk;
  return next.length <= SERVICE_LOG_MAX ? next : next.slice(-SERVICE_LOG_MAX);
}

/** HTTP 契约用的公开形状（`serviceSchema` 解析的就是它）。 */export function servicePublic(service: SessionService) {
  return {
    id: service.id,
    projectId: service.projectId,
    taskId: service.taskId,
    workspaceId: service.workspaceId,
    sessionId: service.sessionId,
    workerId: service.workerId,
    root: service.root,
    command: service.command,
    port: service.port,
    env: { ...service.env },
    restart: service.restart,
    state: service.state,
    pid: service.pid,
    detail: service.detail,
    startedAt: service.startedAt,
    updatedAt: service.updatedAt
  };
}
