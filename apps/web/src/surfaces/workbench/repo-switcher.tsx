import { useMemo, useState } from 'react';
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

/** 组合会话的仓库切换：只在 git 相关表面出现；单仓不渲染。 */
export function RepoSwitcher({
  members,
  selected,
  onSelect,
  statuses
}: {
  members: readonly FilesContextMemberDto[];
  selected: string | null;
  onSelect: (workspaceId: string) => void;
  statuses: Record<string, RepoStatus>;
}) {
  if (members.length < 2) return null;
  return (
    <div data-testid="repo-switcher" className="flex flex-wrap items-center gap-1" role="tablist" aria-label="仓库">
      {members.map((member) => {
        const active = selected === member.workspaceId;
        const extra = statusText(statuses[member.workspaceId]);
        return (
          <button
            type="button"
            key={member.workspaceId}
            role="tab"
            aria-selected={active}
            data-testid={`repo-switcher-${member.name}`}
            data-member={member.workspaceId}
            title={extra ? `${member.name} · ${extra}` : member.name}
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
    </div>
  );
}
