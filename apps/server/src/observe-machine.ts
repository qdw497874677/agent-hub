import { asUserId, can, type AccessPolicy, type EnrollmentRepository, type Subject, type UserRepository } from '@agent-hub/domain';
import type { ObserveList, ObserveListItem, ObserveListQuery, ObserveNode, ObserveReader, ObserveTrace } from '@agent-hub/observe';

// Kept structurally identical to the SQLite adapter without a server-to-storage dependency.
export type MachineObserveBinding =
  | { readonly origin: 'local' }
  | { readonly origin: 'remote'; readonly workerId: string; readonly enrolledBy: string; readonly createdAt: number };
export interface MachineObserveRecord {
  readonly id: string;
  readonly workerId: string;
  readonly origin: 'local' | 'remote';
  readonly enrollment: { readonly enrolledBy: string; readonly createdAt: number } | null;
  readonly connectedAt: number;
  readonly disconnectedAt: number | null;
}
export interface MachineInstallReport {
  readonly id: string;
  readonly state: 'succeeded' | 'failed' | 'refused';
  readonly at: number;
}
type Awaitable<T> = T | Promise<T>;
export interface MachineObserveDeps {
  readonly records: {
    list(input: { readonly bindings: readonly MachineObserveBinding[]; readonly since: number; readonly limit: number }): Awaitable<readonly MachineObserveRecord[]>;
    byId(id: string): Awaitable<MachineObserveRecord | null>;
    installs?(connectionId: string): Awaitable<{ readonly items: readonly MachineInstallReport[]; readonly truncated: boolean }>;
  };
  readonly enrollment: Pick<EnrollmentRepository, 'listCredentials' | 'credentialFor'>;
  readonly users: Pick<UserRepository, 'byId'>;
  readonly policy: AccessPolicy;
}
export const MACHINE_OBSERVE_SCAN = 500;
// Same 512 UTF-8 byte Observe-only bound as storage; wire IDs have no maximum.
const MACHINE_OBSERVE_ID_MAX_BYTES = 512;
const timestamp = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 8_640_000_000_000_000;
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MACHINE_OBSERVE_ID_MAX_BYTES && v.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(v) && Buffer.byteLength(v, 'utf8') <= MACHINE_OBSERVE_ID_MAX_BYTES;
const valid = (r: MachineObserveRecord | null | undefined): r is MachineObserveRecord => !!r && text(r.id) && text(r.workerId) && timestamp(r.connectedAt) &&
  (r.disconnectedAt === null || (timestamp(r.disconnectedAt) && r.disconnectedAt >= r.connectedAt)) &&
  ((r.origin === 'local' && r.enrollment === null) || (r.origin === 'remote' && r.enrollment !== null && text(r.enrollment?.enrolledBy) && timestamp(r.enrollment?.createdAt)));
const actorOf = (s: unknown): Subject | null => {
  if (!s || typeof s !== 'object') return null;
  if ('system' in s && (s as { system?: boolean }).system === true) return s as Subject;
  if ('user' in s && (s as { user?: { id?: string } }).user?.id) return s as Subject;
  return null;
};

export function createMachineObserveReader(deps: MachineObserveDeps): ObserveReader {
  const access = async (binding: MachineObserveBinding, actor: Subject): Promise<boolean> => {
    const ctx = await deps.policy.context();
    if (binding.origin === 'local') return can(actor, 'worker.read', { kind: 'worker', id: 'local', teamId: ctx.hubTeamId, createdBy: null, local: true }, ctx);
    const credential = await deps.enrollment.credentialFor(binding.workerId);
    if (!credential || credential.workerId !== binding.workerId || credential.revokedAt !== null || credential.enrolledBy !== binding.enrolledBy || credential.createdAt !== binding.createdAt) return false;
    const owner = await deps.users.byId(asUserId(binding.enrolledBy));
    if (!owner || owner.id !== binding.enrolledBy || owner.disabledAt !== null || owner.deletedAt !== null || !text(owner.teamId)) return false;
    return can(actor, 'worker.read', { kind: 'worker', id: binding.workerId, teamId: owner.teamId, createdBy: owner.id, local: false }, ctx);
  };
  const bindingOf = (r: MachineObserveRecord): MachineObserveBinding => r.origin === 'local' ? { origin: 'local' } : { origin: 'remote', workerId: r.workerId, enrolledBy: r.enrollment!.enrolledBy, createdAt: r.enrollment!.createdAt };
  return {
    id: 'machine',
    async list(query: ObserveListQuery, subject: unknown): Promise<ObserveList> {
      const actor = actorOf(subject);
      if (!actor || (query.source && query.source !== 'machine') || query.projectId !== null || query.needsLook) return { items: [], truncated: false };
      const bindings: MachineObserveBinding[] = [];
      const local: MachineObserveBinding = { origin: 'local' };
      if (await access(local, actor)) bindings.push(local);
      for (const credential of await deps.enrollment.listCredentials()) {
        if (!text(credential.workerId) || !text(credential.enrolledBy) || !timestamp(credential.createdAt) || credential.revokedAt !== null) continue;
        const remote: MachineObserveBinding = { origin: 'remote', workerId: credential.workerId, enrolledBy: credential.enrolledBy, createdAt: credential.createdAt };
        if (await access(remote, actor)) bindings.push(remote);
      }
      if (!bindings.length) return { items: [], truncated: false, scanLimit: MACHINE_OBSERVE_SCAN };
      const rows = await deps.records.list({ bindings, since: query.since, limit: MACHINE_OBSERVE_SCAN + 1 });
      const items: ObserveListItem[] = [];
      const limit = Math.max(1, query.limit);
      for (const row of rows.slice(0, MACHINE_OBSERVE_SCAN)) {
        if (!valid(row) || row.connectedAt < query.since || !(await access(bindingOf(row), actor))) continue;
        const state = row.disconnectedAt === null ? 'connected' : 'disconnected';
        items.push({ id: `machine:${row.id}`, source: 'machine', title: 'Worker 连接', projectId: null, at: row.connectedAt, nativeState: state, nativeStateLabel: state === 'connected' ? '已连接（未记录断开）' : '已断开', gap: null });
        if (items.length > limit) break;
      }
      return { items: items.slice(0, limit), truncated: rows.length > MACHINE_OBSERVE_SCAN || items.length > limit, scanLimit: MACHINE_OBSERVE_SCAN };
    },
    async get(id: string, subject: unknown): Promise<ObserveTrace | null> {
      const actor = actorOf(subject);
      if (!actor || !text(id)) return null;
      const row = await deps.records.byId(id);
      if (!valid(row) || row.id !== id || !(await access(bindingOf(row), actor))) return null;
      const state = row.disconnectedAt === null ? 'connected' : 'disconnected';
      const reports = deps.records.installs ? await deps.records.installs(row.id) : { items: [], truncated: false };
      const labels = { succeeded: '报告安装成功', failed: '报告安装失败', refused: '报告拒绝安装' } as const;
      const nodes: ObserveNode[] = [];
      const links: { to: string; label: string }[] = [];
      const seen = new Set<string>();
      let truncated = reports.truncated || reports.items.length > 100;
      for (const report of reports.items.slice(0, 100)) {
        if (!report || !text(report.id) || !/^[1-9][0-9]*$/.test(report.id) || seen.has(report.id) || !Object.hasOwn(labels, report.state) || !timestamp(report.at) || report.at < row.connectedAt || (row.disconnectedAt !== null && report.at > row.disconnectedAt)) { truncated = true; continue; }
        seen.add(report.id);
        const reportId = `machine-install:${report.id}`;
        links.push({ to: reportId, label: '此连接报告' });
        nodes.push({ id: reportId, name: '运行时安装报告', kind: 'machine_install_report', state: report.state, stateLabel: labels[report.state], startedAt: null, endedAt: report.at, durationMs: null, durationLabel: null, parentId: null, links: [], attrs: [] });
      }
      const node: ObserveNode = { id: `machine:${row.id}`, name: 'Worker 连接', kind: 'machine_connection', state, stateLabel: state === 'connected' ? '已连接（未记录断开）' : '已断开', startedAt: row.connectedAt, endedAt: row.disconnectedAt, durationMs: row.disconnectedAt === null ? null : row.disconnectedAt - row.connectedAt, durationLabel: row.disconnectedAt === null ? null : '连接记录跨度', parentId: null, links, attrs: [{ key: 'Worker', value: row.workerId }, { key: '来源', value: row.origin === 'local' ? '本机' : '远端' }, ...(truncated ? [{ key: '安装报告', value: '部分报告未保留或未展示' }] : [])] };
      return { id: `machine:${row.id}`, source: 'machine', headId: node.id, title: 'Worker 连接', projectId: null, externalUrl: null, nodes: [node, ...nodes] };
    }
  };
}
