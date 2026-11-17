import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type TeamWorkspaceViewDto } from '../../shell/api.ts';
import { SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';
import { useWorkers } from '../../shell/workers.tsx';
import { errorText } from '../../shell/admin/shared.tsx';
import { CreateWorkspace, TEAM_WORKSPACES_KEY, useTeamWorkspaces } from './team-workspaces.tsx';
import { shortPath, workspaceName } from '../../atoms/workspace-format.ts';
import {
  claimOwnerLabel,
  claimViewFromTeamRow,
  groupWorkspaceChoices,
  transferBlockedReason,
  type ClaimChoiceView
} from './workspace-claim.ts';

/** 候选行：团队页那一行 + 从它读出来的归属。 */
interface ClaimEntry {
  readonly row: TeamWorkspaceViewDto;
  readonly claim: ClaimChoiceView;
}

/**
 * 把团队里的目录分配给本项目（ADR 0026 Q4 + 独占归属）：一个目录同一时间只属于一个项目。
 * - 可分配（没人认领）→ 点「分配」；
 * - 已经在本项目里 → 不在这里重复列（上面的「已有工作目录」就是它们）；
 * - 别的项目 → 灰的，只能「转移」，转移前二次确认。
 * `workerId` 给了就只列那台机器上的（开始任务时用）。
 */
export function LinkWorkspaces({
  projectId,
  linked,
  workerId,
  onLinked,
  startOpen = false,
  expandSignal = 0
}: {
  projectId: string;
  linked: readonly string[];
  workerId?: string | null;
  onLinked?: (workspaceId: string) => void;
  startOpen?: boolean;
  /** 每次加一就地展开（「这台机器没有 git 基座」时外面的动作按钮用）。 */
  expandSignal?: number;
}) {
  const client = useQueryClient();
  const workers = useWorkers();
  const [open, setOpen] = useState(startOpen);
  const box = useRef<HTMLDivElement | null>(null);
  const [creating, setCreating] = useState(false);
  const [asking, setAsking] = useState<ClaimEntry | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const team = useTeamWorkspaces();
  const local = workers.list.find((worker) => worker.origin === 'local')?.workerId ?? null;
  const entries: ClaimEntry[] = (team.data ?? [])
    .filter(
      ({ workspace }) =>
        workspace.state !== 'removed' &&
        workspace.kind === 'long_lived' &&
        (workerId === undefined || (workspace.workerId ?? local) === workerId)
    )
    .map((row) => ({ row, claim: claimViewFromTeamRow(row) }));
  const groups = groupWorkspaceChoices(entries.map((entry) => entry.claim), projectId);
  const entryOf = (claim: ClaimChoiceView): ClaimEntry | undefined =>
    entries.find((entry) => entry.claim.workspaceId === claim.workspaceId);
  // 本项目的目录上面已经逐条列过（还带取消关联这些动作），这里只数一句，不重复列。
  const assignable = groups.unassigned.filter((claim) => !linked.includes(claim.workspaceId));
  const mine = groups.mine.filter((claim) => !linked.includes(claim.workspaceId));
  const foreign = groups.others.filter((claim) => !linked.includes(claim.workspaceId));
  const empty = team.data !== undefined && assignable.length === 0 && mine.length === 0 && foreign.length === 0;
  const link = useMutation({
    mutationFn: (workspaceId: string) => api.linkWorkspace(projectId, workspaceId),
    onSuccess: async (workspace) => {
      await client.invalidateQueries({ queryKey: ['workspaces', projectId] });
      await client.invalidateQueries({ queryKey: TEAM_WORKSPACES_KEY });
      onLinked?.(workspace.id);
    }
  });
  const transfer = useMutation({
    mutationFn: (workspaceId: string) => api.transferWorkspace(projectId, workspaceId),
    onSuccess: async (workspace) => {
      // 归属变了：本项目的空间列表、团队页、项目列表和画布（可能开着旧目录的会话）都要重读。
      await Promise.all([
        client.invalidateQueries({ queryKey: ['workspaces'] }),
        client.invalidateQueries({ queryKey: TEAM_WORKSPACES_KEY }),
        client.invalidateQueries({ queryKey: ['projects'] }),
        client.invalidateQueries({ queryKey: ['canvas'] })
      ]);
      setMoved(workspace.label ?? workspace.path.split('/').pop() ?? workspace.path);
      setAsking(null);
      onLinked?.(workspace.id);
    }
  });
  // 外面要求展开：先把面板打开，再在下一轮把它滚进视野、焦点落到第一个能分配的项
  useEffect(() => {
    if (expandSignal > 0) setOpen(true);
  }, [expandSignal]);
  useEffect(() => {
    if (expandSignal === 0 || !open) return;
    const element = box.current;
    if (!element) return;
    element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    element.querySelector<HTMLElement>('button[data-testid="ws-link-one"]')?.focus({ preventScroll: true });
  }, [expandSignal, open]);
  return (
    <div ref={box} className={open ? 'mt-2 rounded-sm border border-hair p-2' : 'mt-2'}>
      {open ? (
        <div data-testid="ws-link">
          <p className="mb-1 text-meta text-secondary">把团队里的目录分配给本项目（一个目录只属于一个项目）</p>
          {team.isLoading ? <p className="text-meta text-tertiary">加载中…</p> : null}
          {empty ? (
            <p data-testid="ws-link-empty" className="text-meta text-tertiary">
              这台机器上的目录都已分配给别的项目；可以新建一个，或从团队页把未分配的目录分配过来。
            </p>
          ) : null}
          {assignable.length > 0 ? (
            <div data-testid="ws-group-unassigned" className="mb-2">
              <h4 className="mb-1 text-meta text-secondary">可分配</h4>
              <ul className="space-y-1">
                {assignable.map((claim) => {
                  const row = entryOf(claim)?.row;
                  if (!row) return null;
                  return (
                    <li key={claim.workspaceId} className="flex flex-wrap items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sub text-primary">{workspaceName(row.workspace)}</div>
                        <div className="truncate font-mono text-meta text-tertiary" title={row.workspace.path}>{shortPath(row.workspace.path)}</div>
                      </div>
                      <button
                        type="button"
                        data-testid="ws-link-one"
                        className={`${SECONDARY_BUTTON} shrink-0`}
                        disabled={link.isPending}
                        onClick={() => { setMoved(null); link.mutate(claim.workspaceId); }}
                      >
                        分配
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {foreign.length > 0 ? (
            <div data-testid="ws-group-others" className="mb-2">
              <h4 className="mb-1 text-meta text-secondary">别的项目 <span className="text-tertiary">· 转移过来才能用</span></h4>
              <ul className="space-y-1">
                {foreign.map((claim) => {
                  const entry = entryOf(claim);
                  if (!entry) return null;
                  const blocked = transferBlockedReason(claim, projectId);
                  return (
                    <li
                      key={claim.workspaceId}
                      data-testid="ws-claim-other"
                      className="flex flex-wrap items-start gap-2 rounded-sm border border-hair px-2 py-1.5 opacity-70"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sub text-tertiary">{workspaceName(entry.row.workspace)}</div>
                        <div className="truncate font-mono text-meta text-tertiary" title={entry.row.workspace.path}>{shortPath(entry.row.workspace.path)}</div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                        <span className="text-meta text-tertiary" title={blocked ?? undefined}>属于 {claimOwnerLabel(claim)}</span>
                        <button
                          type="button"
                          data-testid="ws-transfer"
                          className={`${SECONDARY_BUTTON} shrink-0`}
                          disabled={blocked !== null || (transfer.isPending && asking?.claim.workspaceId === claim.workspaceId)}
                          title={blocked ?? undefined}
                          onClick={() => { setMoved(null); transfer.reset(); setAsking(entry); }}
                        >
                          转移
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {mine.length > 0 ? (
            <p className="mb-2 text-meta text-tertiary" data-testid="ws-group-mine">
              另有 {mine.length} 个目录已经属于本项目，在上面的列表里。
            </p>
          ) : null}
          {asking ? (
            <div data-testid="ws-transfer-ask" className="mt-2 mb-2 rounded-sm border border-hair p-2">
              <h4 className="mb-1 text-sub text-primary">把目录转移到本项目？</h4>
              <p className="mb-2 text-meta text-secondary">
                <span className="break-all font-mono">{shortPath(asking.row.workspace.path)}</span>
                {' '}现在属于项目「{claimOwnerLabel(asking.claim)}」。转移后它只属于本项目，源项目不再能看到这个目录；
                源项目还有会话在这里跑时会失败，先停掉再转移。
              </p>
              {transfer.error ? <p className="mb-2 text-meta text-rust">{errorText(transfer.error)}</p> : null}
              <div className="flex flex-wrap justify-end gap-2">
                <button className={SECONDARY_BUTTON} onClick={() => { setAsking(null); transfer.reset(); }} disabled={transfer.isPending}>取消</button>
                <button
                  data-testid="ws-transfer-confirm"
                  className="shrink-0 rounded-control bg-action px-3 py-1.5 text-sub font-medium text-action-fg hover:bg-action/90 disabled:opacity-40"
                  disabled={transfer.isPending}
                  onClick={() => transfer.mutate(asking.claim.workspaceId)}
                >
                  {transfer.isPending ? '转移中…' : '确认转移'}
                </button>
              </div>
            </div>
          ) : null}
          {link.error ? <p className="mt-1 text-meta text-rust">{errorText(link.error)}</p> : null}
          {moved ? (
            <p className="mt-1 text-meta text-secondary" data-testid="ws-transfer-done">已把「{moved}」转移到本项目。</p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-3">
            <button type="button" className="text-meta text-link hover:underline" onClick={() => setCreating((v) => !v)}>＋ 新建目录并分配</button>
            <button type="button" className="text-meta text-tertiary hover:underline" onClick={() => { setOpen(false); setAsking(null); }}>收起</button>
          </div>
          {creating ? (
            <div className="mt-2">
              <CreateWorkspace projectId={projectId} onDone={(id) => { setCreating(false); if (id) onLinked?.(id); }} />
            </div>
          ) : null}
        </div>
      ) : (
        // 一行次要文字按钮：它是单选组之外的补充入口，别做得跟「新建工作目录」一样重
        <button type="button" data-testid="ws-link-open" className="text-meta text-secondary hover:text-link hover:underline" onClick={() => setOpen(true)}>
          🔗 把目录分配给本项目…
        </button>
      )}
    </div>
  );
}
