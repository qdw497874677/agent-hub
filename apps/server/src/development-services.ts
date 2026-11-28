import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { asWorkspaceId, authorizeWorker, authorizeWorkspace, isUsable, workerReader } from '@agent-hub/domain';
import type { Deps, DomainError, Principal, ProcessInfo, Result, WorkerStatus, Workspace } from '@agent-hub/domain';

export interface DevelopmentServiceSelection {
  readonly id: string;
  readonly name: string;
  readonly port: number;
  readonly workspaceId: string;
  readonly workerId: string;
  readonly root: string;
  /** Internal observed process path; never include in browser DTOs. */
  readonly cwd: string;
  readonly listenerIdentity: string;
  readonly openable: boolean;
}
export interface DevelopmentServiceView {
  readonly id: string | null;
  readonly port: number;
  readonly name: string;
  readonly openable: boolean;
}
export interface DevelopmentWorkerView {
  readonly state: 'ready' | 'offline' | 'unavailable';
  readonly groups: readonly { readonly workspaceId: string | null; readonly name: string; readonly services: readonly DevelopmentServiceView[] }[];
}
export interface DevelopmentServicesOptions {
  readonly deps: Pick<Deps, 'access' | 'gateway' | 'workspaces' | 'projects' | 'tasks'>;
  readonly canOpen: (workerId: string) => boolean;
}

const validActor = (actor: Principal): boolean => !!actor && actor.via === undefined && !!actor.user?.id && actor.user.disabledAt === null && actor.user.deletedAt === null && actor.user.emailVerifiedAt !== null;
const validPort = (port: number): boolean => Number.isInteger(port) && port >= 1024 && port <= 65535;
const pathOf = (path: string): string | null => typeof path === 'string' && path.startsWith('/') && !path.includes('\0') ? posix.normalize(path).replace(/\/+$/, '') || '/' : null;
const contains = (root: string, path: string): boolean => root === '/' || path === root || path.startsWith(`${root}/`);
const serviceId = (workerId: string, workspaceId: string, port: number, root: string, identity: string): string => {
  const locator = Buffer.from(JSON.stringify([workerId, workspaceId, port])).toString('base64url');
  const digest = createHash('sha256').update(JSON.stringify([workerId, workspaceId, port, root, identity])).digest('hex');
  return `ds_${digest}.${locator}`;
};
function parseId(id: string): [string, string, number] | null {
  if (typeof id !== 'string' || id.length > 2048 || !/^ds_[a-f0-9]{64}\.[A-Za-z0-9_-]+$/.test(id)) return null;
  try {
    const encoded = id.slice(68);
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) return null;
    const value: unknown = JSON.parse(decoded.toString('utf8'));
    if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== 'string' || !value[0] || value[0].length > 256 || typeof value[1] !== 'string' || !value[1] || value[1].length > 256 || typeof value[2] !== 'number' || !validPort(value[2])) return null;
    if (Buffer.from(JSON.stringify(value)).toString('base64url') !== encoded) return null;
    return [value[0], value[1], value[2]];
  } catch { return null; }
}

/** Discovery is scoped to one requested worker. Listener evidence and filesystem paths stay internal. */
export function createDevelopmentServices({ deps, canOpen }: DevelopmentServicesOptions) {
  // Additive protocol: older gateways have no canonical-root proof and fail closed.
  const gateway = deps.gateway as typeof deps.gateway & { developmentRoots?: (workerId: string, paths: readonly string[]) => Promise<Result<readonly (string | null)[], DomainError>> };
  const inFlight = new Map<string, Promise<Awaited<ReturnType<NonNullable<Deps['gateway']['processes']>>>>>();
  async function scan(workerId: string) {
    if (!deps.gateway.processes) return null;
    let pending = inFlight.get(workerId);
    if (!pending) {
      if (inFlight.size >= 8) return null;
      pending = Promise.resolve().then(() => deps.gateway.processes!(workerId));
      inFlight.set(workerId, pending);
      void pending.finally(() => { if (inFlight.get(workerId) === pending) inFlight.delete(workerId); }).catch(() => {});
    }
    try { return await pending; } catch { return null; }
  }
  async function readable(actor: Principal, workerId: string): Promise<boolean> {
    return validActor(actor) && await (await workerReader(deps.access, actor))(workerId);
  }
  async function registrations(worker: WorkerStatus): Promise<Workspace[]> {
    const direct = await deps.workspaces.onMachine(worker.workerId);
    const legacy = worker.origin === 'local' ? await deps.workspaces.onMachine(null) : [];
    return [...direct, ...legacy].filter((w) => w.state !== 'removed');
  }
  type PhysicalRoot = { workspace: Workspace; root: string };
  const fingerprint = (rows: Workspace[]): string => JSON.stringify(rows.map((w) => [w.id, w.workerId, w.path, w.state, w.kind, w.projectId, w.ownerTaskId, w.teamId, w.label]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  async function physicalRoots(worker: WorkerStatus, cwd?: string): Promise<PhysicalRoot[] | null> {
    if (!gateway.developmentRoots) return null;
    const rows = await registrations(worker);
    if (rows.some((w) => !pathOf(w.path))) return null;
    const paths = [...new Set([...rows.map((w) => w.path), ...(cwd ? [cwd] : [])])];
    if (paths.length > 256 || rows.length > 256) return null;
    let resolved: Result<readonly (string | null)[], DomainError>;
    try { resolved = await gateway.developmentRoots(worker.workerId, paths); } catch { return null; }
    if (!resolved?.ok || !Array.isArray(resolved.value) || resolved.value.length !== paths.length || resolved.value.some((root) => !root || pathOf(root) !== root)) return null;
    const lookup = new Map(paths.map((path, index) => [path, resolved.value[index]!]));
    if (cwd && lookup.get(cwd) !== cwd) return null;
    if (fingerprint(rows) !== fingerprint(await registrations(worker))) return null;
    return rows.map((workspace) => ({ workspace, root: lookup.get(workspace.path)! }));
  }
  function uniqueOwner(roots: PhysicalRoot[], cwd: string, workspaceId: string, root: string): boolean {
    const matches = roots.filter((entry) => contains(entry.root, cwd)).sort((a, b) => b.root.length - a.root.length);
    return matches[0]?.workspace.id === workspaceId && matches[0].root === root && isUsable(matches[0].workspace) && matches[1]?.root !== root;
  }
  async function allowedWorkspace(actor: Principal, workspace: Workspace): Promise<boolean> {
    if (!isUsable(workspace)) return false;
    if (workspace.kind === 'temporary') {
      if (!workspace.projectId || !workspace.ownerTaskId) return false;
      const task = await deps.tasks.byId(workspace.ownerTaskId);
      if (!task || task.projectId !== workspace.projectId) return false;
    } else {
      // More than one project owner is not unambiguous evidence of attribution.
      if ((await deps.workspaces.linksOf(workspace.id)).length > 1) return false;
    }
    return (await authorizeWorkspace(deps, actor, workspace, 'workspace.files.read')).ok;
  }
  async function verifiedWorkspace(actor: Principal, target: { workerId: string; workspaceId: string; root: string; cwd: string }, requireUse: boolean): Promise<boolean> {
    if (!(await readable(actor, target.workerId))) return false;
    const worker = (await deps.gateway.status()).find((w) => w.workerId === target.workerId);
    if (!worker || worker.state !== 'online' || (requireUse && !(await authorizeWorker(deps.access, actor, target.workerId)).ok)) return false;
    const root = pathOf(target.root);
    const cwd = pathOf(target.cwd);
    if (!root || root !== target.root || !cwd || cwd !== target.cwd || !contains(root, cwd)) return false;
    const current = await deps.workspaces.byId(asWorkspaceId(target.workspaceId));
    if (!current || (current.workerId !== worker.workerId && !(worker.origin === 'local' && current.workerId === null))) return false;
    if (!(await allowedWorkspace(actor, current))) return false;
    if (!(await readable(actor, target.workerId)) || (requireUse && !(await authorizeWorker(deps.access, actor, target.workerId)).ok)) return false;
    // Re-read all registrations after asynchronous ACL checks, including hidden ones.
    const roots = await physicalRoots(worker, cwd);
    if (!roots || !uniqueOwner(roots, cwd, target.workspaceId, root)) return false;
    const fresh = roots.find((entry) => entry.workspace.id === target.workspaceId)?.workspace;
    if (!fresh || fingerprint([fresh]) !== fingerprint([current]) || !(await allowedWorkspace(actor, fresh))) return false;
    if (fingerprint(roots.map((entry) => entry.workspace)) !== fingerprint(await registrations(worker))) return false;
    return await readable(actor, target.workerId) && (!requireUse || (await authorizeWorker(deps.access, actor, target.workerId)).ok);
  }
  async function inspect(actor: Principal, workerId: string): Promise<{ view: DevelopmentWorkerView; selections: DevelopmentServiceSelection[] } | null> {
    if (!(await readable(actor, workerId))) return null;
    const worker = (await deps.gateway.status()).find((w) => w.workerId === workerId);
    if (!worker) return null;
    if (worker.state !== 'online') return { view: { state: 'offline', groups: [] }, selections: [] };
    const result = await scan(workerId);
    // Revalidate visibility and the machine state after the potentially slow call.
    if (!(await readable(actor, workerId))) return null;
    const fresh = (await deps.gateway.status()).find((w) => w.workerId === workerId);
    if (!fresh) return null;
    if (fresh.state !== 'online') return { view: { state: 'offline', groups: [] }, selections: [] };
    if (!result?.ok) return { view: { state: 'unavailable', groups: [] }, selections: [] };
    const all = await physicalRoots(fresh);
    if (!all) return { view: { state: 'unavailable', groups: [] }, selections: [] };
    const use = (await authorizeWorker(deps.access, actor, workerId)).ok;
    const groups = new Map<string, { workspaceId: string; name: string; services: DevelopmentServiceView[] }>();
    const selections: DevelopmentServiceSelection[] = [];
    const targets = new Map<number, { workerId: string; workspaceId: string; root: string; cwd: string }>();
    // Conflicting reports for a port are not proof of which process owns it.
    const byPort = new Map<number, { process: ProcessInfo; identity: string | null }[]>();
    for (const process of result.value) {
      for (const port of new Set(process.ports.filter(validPort))) {
        const identities = process.listeners?.filter((l) => l.port === port && /^[a-f0-9]{64}$/.test(l.identity)).map((l) => l.identity) ?? [];
        const entries = byPort.get(port) ?? [];
        entries.push({ process, identity: identities.length === 1 ? identities[0]! : null });
        byPort.set(port, entries);
      }
    }
    for (const [port, entries] of byPort) {
      if (entries.length !== 1) continue;
      const entry = entries[0]!;
      if ((entry.process as ProcessInfo & { cwdVerified?: true }).cwdVerified !== true) continue;
      const cwd = pathOf(entry.process.cwd);
      if (!cwd || cwd !== entry.process.cwd) continue;
      const matches = all.filter(({ root }) => contains(root, cwd)).sort((a, b) => b.root.length - a.root.length);
      const match = matches[0];
      if (!match || matches[1]?.root === match.root) continue;
      const current = await deps.workspaces.byId(match.workspace.id);
      if (!current || fingerprint([current]) !== fingerprint([match.workspace]) || !(await allowedWorkspace(actor, current))) continue;
      const name = `端口 ${port}`;
      const openable = use && !!entry.identity && canOpen(workerId);
      const id = entry.identity ? serviceId(workerId, current.id, port, match.root, entry.identity) : null;
      const group = groups.get(current.id) ?? { workspaceId: current.id, name: current.label || 'WorkDir', services: [] };
      group.services.push({ id, port, name, openable });
      groups.set(current.id, group);
      targets.set(port, { workerId, workspaceId: current.id, root: match.root, cwd });
      if (id && entry.identity) {
        selections.push({ id, name, port, workspaceId: current.id, workerId, root: match.root, cwd, listenerIdentity: entry.identity, openable });
      }
    }
    // A policy change during projection must not release stale results.
    if (!(await readable(actor, workerId))) return null;
    const stillUse = use && (await authorizeWorker(deps.access, actor, workerId)).ok;
    const finalRoots = await physicalRoots(fresh);
    if (!finalRoots) return { view: { state: 'unavailable', groups: [] }, selections: [] };
    // Recheck all projected rows together after building the projection, so a slow
    // check of another WorkDir cannot leave an earlier label with stale ACLs.
    const checked = await Promise.all([...groups.values()].map(async (group) => {
      const current = await deps.workspaces.byId(asWorkspaceId(group.workspaceId));
      const registered = finalRoots.find((r) => r.workspace.id === group.workspaceId)?.workspace;
      if (!current || !registered || fingerprint([current]) !== fingerprint([registered]) || (current.label || 'WorkDir') !== group.name || !(await allowedWorkspace(actor, current))) return null;
      const valid = await Promise.all(group.services.map(async (service) => {
        const target = targets.get(service.port);
        return target && uniqueOwner(finalRoots, target.cwd, target.workspaceId, target.root) ? { ...service, openable: stillUse && service.openable } : null;
      }));
      const services = valid.filter((s): s is DevelopmentServiceView => s !== null);
      return services.length ? { ...group, services } : null;
    }));
    const visibleGroups = checked.filter((g): g is NonNullable<typeof g> => g !== null);
    if (fingerprint(finalRoots.map((r) => r.workspace)) !== fingerprint(await registrations(fresh))) return { view: { state: 'unavailable', groups: [] }, selections: [] };
    if (!(await readable(actor, workerId))) return null;
    const visibleIds = new Set(visibleGroups.flatMap((g) => g.services.flatMap((s) => s.id ? [s.id] : [])));
    return { view: { state: 'ready', groups: visibleGroups }, selections: selections.filter((s) => visibleIds.has(s.id)).map((s) => ({ ...s, openable: stillUse && s.openable })) };
  }
  return {
    async workers(actor: Principal) {
      if (!validActor(actor)) return [];
      const statuses = await deps.gateway.status();
      const read = await workerReader(deps.access, actor);
      const visible = await Promise.all(statuses.map(async (w) => (await read(w.workerId)) ? { id: w.workerId, name: w.label, state: w.state } : null));
      return visible.filter((w): w is NonNullable<typeof w> => w !== null);
    },
    async worker(actor: Principal, workerId: string): Promise<DevelopmentWorkerView | null> { return (await inspect(actor, workerId))?.view ?? null; },
    async service(actor: Principal, id: string): Promise<DevelopmentServiceSelection | null> {
      const locator = parseId(id);
      if (!locator) return null;
      const inspected = await inspect(actor, locator[0]);
      const selected = inspected?.selections.find((s) => s.id === id && s.workspaceId === locator[1] && s.port === locator[2]);
      return selected && await verifiedWorkspace(actor, selected, false) ? selected : null;
    },
    async selectOpen(actor: Principal, id: string): Promise<DevelopmentServiceSelection | null> {
      const locator = parseId(id);
      if (!locator) return null;
      const inspected = await inspect(actor, locator[0]);
      const selected = inspected?.selections.find((s) => s.id === id && s.openable);
      return selected && canOpen(selected.workerId) && await verifiedWorkspace(actor, selected, true) ? selected : null;
    },
    async manual(actor: Principal, input: { workerId: string; workspaceId: string; port: number }): Promise<DevelopmentServiceSelection | null> {
      if (!input.workerId || !input.workspaceId || !validPort(input.port)) return null;
      const inspected = await inspect(actor, input.workerId);
      const selected = inspected?.selections.find((s) => s.workspaceId === input.workspaceId && s.port === input.port && s.openable);
      return selected && canOpen(selected.workerId) && await verifiedWorkspace(actor, selected, true) ? selected : null;
    },
    authorizeDestination(actor: Principal, target: { workerId: string; workspaceId: string; root: string; cwd: string }): Promise<boolean> { return verifiedWorkspace(actor, target, true); }
  };
}
