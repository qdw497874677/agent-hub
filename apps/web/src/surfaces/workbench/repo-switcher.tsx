import { useId, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { filesApi, gitApi, type FilesContextMemberDto } from '../../shell/api.ts';
import { gitKeys } from '../../shell/query-keys.ts';

export interface RepoStatus {
  readonly branch: string | null;
  readonly dirty: number;
  readonly ahead: number;
  readonly state: FilesContextMemberDto['state'];
  readonly sizeBytes?: number | null;
}

export function useSessionRepo(sessionId: string, primaryWorkspaceId: string | null) {
  const context = useQuery({
    queryKey: ['files', sessionId, 'combo-context'],
    queryFn: () => filesApi.context(sessionId),
    staleTime: 15_000
  });
  const members = context.data?.group?.members ?? [];
  const isCombo = members.length > 0;
  const [picked, setPicked] = useState<string | null>(null);
  const selected = useMemo(() => {
    if (!isCombo) return null;
    if (picked && members.some((member) => member.workspaceId === picked)) return picked;
    if (primaryWorkspaceId && members.some((member) => member.workspaceId === primaryWorkspaceId)) return primaryWorkspaceId;
    return members[0]?.workspaceId ?? null;
  }, [isCombo, picked, members, primaryWorkspaceId]);

  const statusQueries = useQueries({
    queries: members.map((member) => ({
      queryKey: gitKeys.state(member.workspaceId, sessionId),
      queryFn: () => gitApi.state(sessionId, member.workspaceId),
      enabled: member.state === 'ready',
      staleTime: 15_000,
      retry: false as const
    }))
  });

  const statuses: Record<string, RepoStatus> = {};
  members.forEach((member, index) => {
    const state = statusQueries[index]?.data;
    statuses[member.workspaceId] = {
      branch: state?.branch ?? null,
      dirty: state?.files.length ?? 0,
      ahead: state?.ahead ?? 0,
      state: member.state,
      sizeBytes: state?.sizeBytes
    };
  });

  return { isCombo, members, selected, setSelected: setPicked, statuses, groupRoot: context.data?.group?.root ?? null };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function statusText(status: RepoStatus | undefined): string {
  if (!status) return '';
  if (status.state === 'preparing') return '准备中';
  if (status.state === 'failed') return '失败';
  const bits = [
    status.branch,
    status.dirty > 0 ? `${status.dirty} 改动` : null,
    status.ahead > 0 ? `↑${status.ahead}` : null,
    status.sizeBytes && status.sizeBytes > 0 ? formatSize(status.sizeBytes) : null
  ].filter(Boolean);
  return bits.join(' · ');
}

/**
 * 窄屏抽屉里只留「准备中 / 失败」：分支和大小在抽屉上半截已经有一条（跟着页签切换），
 * 每个页签再念一遍分支名只会把三行拉成六行。
 */
function stateText(state: FilesContextMemberDto['state']): string {
  return state === 'ready' ? '' : statusText({ branch: null, dirty: 0, ahead: 0, state });
}

export interface AddableRepo {
  readonly id: string;
  readonly name: string;
}

/** 加仓库这一下的结果：没加上就留在原地，别用全局 toast 把它搬走。 */
export interface RepoAddNotice {
  /** 这条结论讲的是哪个仓库：同一个仓库不会既在短名单里又有结论。 */
  readonly repoId: string;
  /** ok：确实进去了；error：权威读确认没进去（可重试）；muted：结论没定，或进去了但没就绪。 */
  readonly kind: 'ok' | 'error' | 'muted';
  readonly text: string;
  /** 只在「权威读证明这个 repoId 确实不在组里」时给：后端没有幂等键，多打一次会多建一个工作目录。 */
  readonly retryRepoId?: string;
  /** 结论没定时只给只读的「重新确认」，绝不重发。 */
  readonly recheckRepoId?: string;
}

/**
 * 组合会话的仓库切换：只在 git 相关表面出现；单仓不渲染。
 * 一员组合在还能加仓时也显示。
 *
 * `inline` 是给窄屏抽屉用的：候选列表跟着按钮在流里往下长，不再绝对定位——
 * 抽屉的内容区本身会滚（`overflow-y-auto`），绝对定位的下拉会被裁掉一截。
 */
export function RepoSwitcher({
  members,
  selected,
  onSelect,
  statuses,
  addable = [],
  onAdd,
  onRetry,
  onRecheck,
  adding = null,
  inline = false,
  notices = []
}: {
  members: readonly FilesContextMemberDto[];
  selected: string | null;
  onSelect: (workspaceId: string) => void;
  statuses: Record<string, RepoStatus>;
  addable?: readonly AddableRepo[];
  onAdd?: (repoId: string) => void;
  onRetry?: (repoId: string) => void;
  onRecheck?: (repoId: string) => void;
  adding?: string | null;
  inline?: boolean;
  notices?: readonly RepoAddNotice[];
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  // 短名单空了也别把结论一起藏掉：一个成员的组加完最后一个仓库时，提示还得留在原地。
  if (members.length < 2 && addable.length === 0 && notices.length === 0) return null;
  const busy = adding !== null;
  return (
    <div
      data-testid="repo-switcher"
      className={`flex flex-wrap items-center gap-1 ${inline ? 'w-full' : ''}`}
      role="tablist"
      aria-label="仓库"
    >
      {members.map((member) => {
        const active = selected === member.workspaceId;
        const detail = statusText(statuses[member.workspaceId]);
        const extra = inline ? stateText(member.state) : detail;
        return (
          <button
            type="button"
            key={member.workspaceId}
            role="tab"
            aria-selected={active}
            data-testid={`repo-switcher-${member.name}`}
            data-member={member.workspaceId}
            title={detail ? `${member.name} · ${detail}` : member.name}
            className={`rounded-sm border px-1.5 py-0.5 text-meta ${
              active ? 'border-fg/40 bg-selected text-primary' : 'border-hair text-secondary hover:border-strong'
            }`}
            onClick={() => onSelect(member.workspaceId)}
          >
            <span className="font-mono">{member.name}</span>
            {extra ? <span className="ml-1 text-tertiary">{extra}</span> : null}
          </button>
        );
      })}
      {addable.length > 0 && onAdd ? (
        inline ? (
          <>
            <AddTrigger open={open} busy={busy} listId={listId} onToggle={() => setOpen((value) => !value)} />
            {open ? <AddList inline id={listId} addable={addable} busy={busy} onPick={onAdd} onDone={() => setOpen(false)} /> : null}
          </>
        ) : (
          <div className="relative">
            <AddTrigger open={open} busy={busy} listId={listId} onToggle={() => setOpen((value) => !value)} />
            {open ? <AddList id={listId} addable={addable} busy={busy} onPick={onAdd} onDone={() => setOpen(false)} /> : null}
          </div>
        )
      ) : null}
      {notices.map((notice) => (
        <AddNotice key={notice.repoId} notice={notice} busy={busy} onRetry={onRetry} onRecheck={onRecheck} />
      ))}
    </div>
  );
}

function AddTrigger({ open, busy, listId, onToggle }: { open: boolean; busy: boolean; listId: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="rounded-sm border border-hair px-1.5 py-0.5 text-meta text-secondary hover:border-strong disabled:opacity-60"
      data-testid="repo-add"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      disabled={busy}
      onClick={onToggle}
    >
      {busy ? '添加中…' : '添加仓库'}
    </button>
  );
}

/**
 * 候选仓库。`inline` 时占满一整行（抽屉里不做浮层，不会被内容区的滚动裁掉）。
 * 每个候选 44px：手指点得中，和抽屉里其它按钮一个高度。
 */
function AddList({
  id,
  addable,
  busy,
  onPick,
  onDone,
  inline = false
}: {
  id: string;
  addable: readonly AddableRepo[];
  busy: boolean;
  onPick: (repoId: string) => void;
  onDone: () => void;
  inline?: boolean;
}) {
  return (
    <div
      id={id}
      data-testid="repo-add-menu"
      className={
        inline
          ? 'mt-1 basis-full rounded-sm border border-hair bg-card p-1'
          : 'absolute left-0 top-full z-20 mt-1 min-w-[8rem] rounded-sm border border-hair bg-card py-1 shadow-sm'
      }
    >
      {inline ? <p className="px-2 pb-0.5 pt-1 text-meta text-tertiary">加到组合工作目录</p> : null}
      {addable.map((repo) => (
        <button
          type="button"
          key={repo.id}
          className={
            inline
              ? 'flex min-h-[44px] w-full items-center rounded-sm px-2 text-left font-mono text-meta text-secondary hover:bg-hair/40 disabled:opacity-40'
              : 'block w-full px-2 py-1 text-left font-mono text-meta text-secondary hover:bg-hair/40 disabled:opacity-40'
          }
          data-testid={`repo-add-${repo.name}`}
          disabled={busy}
          onClick={() => {
            onDone();
            onPick(repo.id);
          }}
        >
          {repo.name}
        </button>
      ))}
    </div>
  );
}

function AddNotice({
  notice,
  busy,
  onRetry,
  onRecheck
}: {
  notice: RepoAddNotice;
  busy: boolean;
  onRetry?: (repoId: string) => void;
  onRecheck?: (repoId: string) => void;
}) {
  const retry = notice.retryRepoId;
  const recheck = notice.recheckRepoId;
  const tone =
    notice.kind === 'error'
      ? 'border-rust/40 text-rust'
      : notice.kind === 'ok'
        ? 'border-sage/40 text-sage'
        : 'border-hair text-secondary';
  return (
    <div
      role={notice.kind === 'error' ? 'alert' : 'status'}
      data-testid="repo-add-notice"
      data-repo={notice.repoId}
      data-kind={notice.kind}
      className={`flex basis-full flex-wrap items-center gap-x-2 gap-y-1 rounded-sm border px-2 py-1 text-meta ${tone}`}
    >
      <span className="min-w-0 flex-1">{notice.text}</span>
      {retry !== undefined && onRetry ? (
        <button
          type="button"
          data-testid="repo-add-retry"
          disabled={busy}
          className="shrink-0 underline decoration-dotted underline-offset-2 disabled:opacity-40"
          onClick={() => onRetry(retry)}
        >
          重试
        </button>
      ) : null}
      {recheck !== undefined && onRecheck ? (
        <button
          type="button"
          data-testid="repo-add-recheck"
          disabled={busy}
          className="shrink-0 underline decoration-dotted underline-offset-2 disabled:opacity-40"
          onClick={() => onRecheck(recheck)}
        >
          重新确认
        </button>
      ) : null}
    </div>
  );
}
