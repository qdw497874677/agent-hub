import type { PreviewLinkDto, ServiceDto } from '@agent-hub/contract';

/**
 * 本地服务那一块的纯逻辑（docs/design/session-service.md §4 / §9）。
 *
 * 状态只有服务端回报的那四种（starting / running / failed / stopped）；
 * 「机器离线」不是服务状态，是这台机器此刻没人应答，所以单独用一个开关叠上去。
 * 这里不碰 DOM，组件只负责渲染和请求。
 */

/** 日志只留最后 8 KiB：和 domain 的 `SERVICE_LOG_MAX` 一致，界面上也照这个数说。 */
export const SERVICE_LOG_MAX = 8 * 1024;
/** 端口区间下限：1024 以下留给系统，和契约 `createServiceRequest.port` 一致。 */
export const SERVICE_MIN_PORT = 1024;
export const SERVICE_MAX_PORT = 65535;
/** 命令长度上限，和契约的 max(2000) 对齐。 */
export const SERVICE_COMMAND_LIMIT = 2000;

export type ServiceState = ServiceDto['state'];

/** 行上那一小块颜色：复用既有语义色，不新开色板。 */
export type ServiceTone = 'sage' | 'accent' | 'rust' | 'tertiary';

export interface ServiceStateFlags {
  /** 这台机器的 Worker 此刻不在线（服务自身状态可能还停在 running）。 */
  readonly offline?: boolean;
  /** 停止指令已发出、还没等到 Worker 回报。 */
  readonly stopping?: boolean;
}

/** 状态那一格的中文。停止中优先：那几秒里说「运行中」会让人以为没点上。 */
export function serviceStateText(state: ServiceState, flags: ServiceStateFlags = {}): string {
  if (flags.stopping === true) return '停止中';
  if (flags.offline === true && (state === 'running' || state === 'starting')) return '机器离线';
  if (state === 'starting') return '启动中';
  if (state === 'running') return '运行中';
  if (state === 'failed') return '失败';
  return '已停止';
}

export function serviceStateTone(state: ServiceState, flags: ServiceStateFlags = {}): ServiceTone {
  if (flags.stopping === true) return 'accent';
  if (flags.offline === true && (state === 'running' || state === 'starting')) return 'tertiary';
  if (state === 'running') return 'sage';
  if (state === 'starting') return 'accent';
  if (state === 'failed') return 'rust';
  return 'tertiary';
}

/** 端口那一格：没填端口就是「自动」，别画一个 0 或者空着。 */
export function servicePortText(port: number | null | undefined): string {
  return port === null || port === undefined ? '端口自动' : `端口 ${port}`;
}

/** 一段时长的人话：只到分钟，秒级抖动对「它跑了多久」没有意义。 */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
  return `${Math.floor(hours / 24)} 天`;
}

/**
 * 运行时长。跑着的算到「现在」，停了的算到状态最后一次更新：
 * 停止之后时钟还在走，但那个数字不该继续涨。
 */
export function serviceAgeText(service: Pick<ServiceDto, 'state' | 'startedAt' | 'updatedAt'>, now: number): string | null {
  if (service.startedAt === null) return null;
  const until = service.state === 'running' || service.state === 'starting' ? now : service.updatedAt;
  return durationText(until - service.startedAt);
}

/** 行上的第二行信息：「pid 1234 · 已运行 3 分钟」，缺哪项就少说哪项。 */
export function serviceMetaText(
  service: Pick<ServiceDto, 'state' | 'startedAt' | 'updatedAt' | 'pid'>,
  now: number
): string {
  const parts: string[] = [];
  if (service.pid !== null) parts.push(`pid ${service.pid}`);
  const age = serviceAgeText(service, now);
  if (age !== null) parts.push(service.state === 'running' ? `已运行 ${age}` : `跑了 ${age}`);
  return parts.join(' · ');
}

/**
 * 端口对应的预览链接：契约里预览链接没有 serviceId，只能按端口认；
 * 同一端口优先认同一台机器上的那条。
 */
export function servicePreviewLink(
  links: readonly PreviewLinkDto[],
  service: Pick<ServiceDto, 'port' | 'workerId'>
): PreviewLinkDto | null {
  if (service.port === null) return null;
  const samePort = links.filter((link) => link.port === service.port);
  return samePort.find((link) => link.workerId === service.workerId) ?? samePort[0] ?? null;
}

/** 端口输入：留空 = 让服务自己挑（后端允许 null），填了就得是 1024–65535。 */
export function servicePortProblem(value: string): string | null {
  const port = value.trim();
  if (port === '') return null;
  if (!/^\d+$/.test(port)) return '端口只能是数字';
  const number = Number(port);
  if (number < SERVICE_MIN_PORT || number > SERVICE_MAX_PORT) {
    return `端口要在 ${SERVICE_MIN_PORT}–${SERVICE_MAX_PORT} 之间`;
  }
  return null;
}

/** 命令输入：和契约一样，不能空、不能超过 2000 字。 */
export function serviceCommandProblem(value: string): string | null {
  const command = value.trim();
  if (command === '') return '先写要跑的命令';
  if ([...command].length > SERVICE_COMMAND_LIMIT) return `命令最多 ${SERVICE_COMMAND_LIMIT} 个字`;
  return null;
}

/** 工作空间输入：留空 = 用会话的工作目录；填了必须是绝对路径。 */
export function serviceRootProblem(value: string): string | null {
  const root = value.trim();
  if (root === '') return null;
  if (!root.startsWith('/')) return '工作空间要是绝对路径';
  return null;
}

const STATE_RANK: Record<ServiceState, number> = { starting: 0, running: 1, failed: 2, stopped: 3 };

/** 在跑的排前面，其余按最近更新时间倒序：刚起的服务就在眼前。 */
export function sortServices<T extends Pick<ServiceDto, 'state' | 'updatedAt'>>(services: readonly T[]): T[] {
  return [...services].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.updatedAt - a.updatedAt);
}
