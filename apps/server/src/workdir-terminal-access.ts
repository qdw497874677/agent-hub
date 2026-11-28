import {
  asProjectId,
  asWorkspaceId,
  authorizeProject,
  authorizeWorker,
  isUsable,
  normalizePath
} from '@agent-hub/domain';
import type { Deps, Principal, Subject, Workspace } from '@agent-hub/domain';

/** The path is internal to the hub/worker protocol and must never be returned to a browser. */
export interface WorkDirTerminalTarget {
  readonly workspace: Workspace;
  readonly workerId: string;
}

export type WorkDirTerminalEligibility =
  | { readonly ok: true; readonly principal: Principal; readonly target: WorkDirTerminalTarget }
  | { readonly ok: false; readonly reason: 'unauthorized' | 'not_found' | 'forbidden' | 'unavailable' };

/** Invalid configuration grants nothing; IDs are compared literally, never as patterns. */
export function workDirShellGranted(raw: string | undefined, userId: string, workerId: string): boolean {
  if (!raw || !userId || !workerId) return false;
  try {
    const grants: unknown = JSON.parse(raw);
    if (!Array.isArray(grants)) return false;
    if (!grants.every((grant: unknown) => {
      if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return false;
      const value = grant as Record<string, unknown>;
      return typeof value.userId === 'string' && value.userId.length > 0 &&
        typeof value.workerId === 'string' && value.workerId.length > 0;
    })) return false;
    return grants.some((grant: { userId: string; workerId: string }) => grant.userId === userId && grant.workerId === workerId);
  } catch {
    return false;
  }
}

export interface WorkDirTerminalAccessOptions {
  readonly deps: Pick<Deps, 'projects' | 'tasks' | 'workspaces' | 'access'>;
  /** Must resolve the designated local machine only, not an arbitrary online worker. */
  readonly localWorkerId: () => string | null;
  readonly hasGrant: (userId: string, workerId: string) => boolean;
}

/** Re-run on every connection, output, input and resize, including replay and detached revocation. */
export async function workDirTerminalEligibility(
  options: WorkDirTerminalAccessOptions,
  subject: Subject | null,
  projectId: string,
  workspaceId: string,
  ownerId?: string
): Promise<WorkDirTerminalEligibility> {
  if (!subject || 'system' in subject || subject.via !== undefined || !subject.user.id || subject.user.disabledAt !== null || subject.user.deletedAt !== null || subject.user.emailVerifiedAt === null || (ownerId !== undefined && subject.user.id !== ownerId)) {
    return { ok: false, reason: 'unauthorized' };
  }
  const { deps } = options;
  // An absent access policy is not permission to execute arbitrary commands.
  if (!deps.access) return { ok: false, reason: 'forbidden' };
  const project = await deps.projects.byId(asProjectId(projectId));
  if (!(await authorizeProject(deps.access, subject, project, 'project.read')).ok) return { ok: false, reason: 'not_found' };
  const workspace = await deps.workspaces.byId(asWorkspaceId(workspaceId));
  if (!workspace || workspace.groupId || !isUsable(workspace) || !workspace.path.startsWith('/')) return { ok: false, reason: 'not_found' };
  if (workspace.kind === 'temporary') {
    if (workspace.projectId !== projectId || !workspace.ownerTaskId) return { ok: false, reason: 'not_found' };
    const task = await deps.tasks.byId(workspace.ownerTaskId);
    if (!task || task.projectId !== projectId) return { ok: false, reason: 'not_found' };
  } else {
    const links = await deps.workspaces.linksOf(workspace.id);
    if (links.length !== 1 || links[0]?.projectId !== projectId) return { ok: false, reason: 'not_found' };
  }
  const localWorkerId = options.localWorkerId();
  const workerId = workspace.workerId ?? localWorkerId;
  if (!workerId) return { ok: false, reason: 'unavailable' };
  if (!options.hasGrant(subject.user.id, workerId)) return { ok: false, reason: 'forbidden' };
  // Old null worker records have to use the policy's explicit local-machine rule.
  if (!(await authorizeWorker(deps.access, subject, workspace.workerId)).ok) return { ok: false, reason: 'forbidden' };

  // Legacy rows may represent the same local path with either null or the local ID.
  // An ambiguous registration is not proof of exclusive project ownership.
  const machineIds = new Set<string | null>([workspace.workerId]);
  if (localWorkerId && workerId === localWorkerId) {
    machineIds.add(null);
    machineIds.add(localWorkerId);
  }
  for (const id of machineIds) {
    const registrations = await deps.workspaces.onMachine(id);
    if (registrations.some((other) => other.id !== workspace.id && other.state !== 'removed' && normalizePath(other.path) === normalizePath(workspace.path))) {
      return { ok: false, reason: 'not_found' };
    }
  }
  return { ok: true, principal: subject, target: { workspace, workerId } };
}
