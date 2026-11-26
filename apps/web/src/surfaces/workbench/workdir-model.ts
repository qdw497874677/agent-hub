/** Only the immutable fields needed to decide whether a directory can be opened. */
type WorkdirEligibility = { readonly groupId?: string | null; readonly state: string };

/** A project listing is not enough: ownership must be explicit and groups are excluded. */
export function eligibleWorkdir(workspace: WorkdirEligibility, ownerProjectId: string | null, projectId: string): boolean {
  return !workspace.groupId && (workspace.state === 'ready' || workspace.state === 'kept') && ownerProjectId === projectId;
}
