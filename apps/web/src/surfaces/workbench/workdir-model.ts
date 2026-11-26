import { COORDINATOR_TITLE, UNASSIGNED_TITLE } from '../../atoms/session-groups.ts';

/** Only the immutable fields needed to decide whether a directory can be opened. */
type WorkdirEligibility = { readonly groupId?: string | null; readonly state: string };

/** A project listing is not enough: ownership must be explicit and groups are excluded. */
export function eligibleWorkdir(workspace: WorkdirEligibility, ownerProjectId: string | null, projectId: string): boolean {
  return !workspace.groupId && (workspace.state === 'ready' || workspace.state === 'kept') && ownerProjectId === projectId;
}

type LabelItem = { id: string; title: string; needsContext?: boolean };

export function workdirSessionLabel(id: string, session: { title?: string | null } | undefined, task: { title: string } | undefined, coordinator: boolean): LabelItem {
  if (!session) return { id, title: '会话', needsContext: true };
  if (session.title || task?.title) return { id, title: session.title || task!.title };
  return { id, title: coordinator ? COORDINATOR_TITLE : UNASSIGNED_TITLE, needsContext: !coordinator };
}

/** Disambiguate only within the set of labels displayed together. */
export function workdirLabels(items: readonly LabelItem[]): string[] {
  return items.map((item) => item.needsContext || items.filter((other) => other.title === item.title).length > 1
    ? `${item.title} · ${item.id.slice(-4)}` : item.title);
}

export function terminalPollInterval(status: number | undefined, inventory?: { available: boolean; reason?: string; terminals: readonly { state: string }[] }, unresolved = false, isError = false): number | false {
  if (status === 403 || status === 404) return false;
  if (isError || status !== undefined) return 3000;
  if (inventory?.available === false && inventory.reason === '工作目录终端未启用' && !unresolved && inventory.terminals.every((terminal) => terminal.state === 'ended')) return false;
  return 3000;
}

/** Never display the server's error body in a terminal access message. */
export function terminalErrorText(status: number | undefined): string {
  if (status === 403) return '无权访问独立终端';
  if (status === 404) return '独立终端不可用';
  return '独立终端状态暂时无法读取';
}
