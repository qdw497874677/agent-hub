import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../shell/api.ts';
import { groupHeadline, groupStateNote, memberStateLabel, workspaceGroupFrom } from './workspace-group.ts';

/**
 * 会话页页签行上方那一行（docs/design/multi-repo.md §7）：这条会话在组合工作空间里干活时，
 * 显示「组合工作空间 · N 个仓库」，点开看每个仓库的子目录名和准备状态。
 *
 * 只有多仓库派生的会话才有 groupId；单仓库会话整行不出现（和 worktree-status 同一个思路：
 * 常态不占屏）。准备中的组每 3 秒刷新一次，ready / failed 之后不再轮询。
 */
export function SessionGroupLine({ groupId }: { groupId: string }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['workspace-group', groupId],
    queryFn: () => api.workspaceGroup(groupId),
    refetchInterval: (current) => (workspaceGroupFrom(current.state.data)?.state === 'preparing' ? 3000 : false)
  });
  const group = workspaceGroupFrom(query.data);
  if (group === null) {
    // 查不到就说一句；准备中的组还没回来时保持安静，别闪一条「加载中」
    return query.error ? (
      <p className="shrink-0 border-b border-hair px-2 py-1 text-meta text-rust md:px-3" data-testid="session-group">
        组合工作空间信息读取失败：{(query.error as Error).message}
      </p>
    ) : null;
  }
  const note = groupStateNote(group);
  const tone = group.state === 'failed' ? 'text-rust' : group.state === 'preparing' ? 'text-secondary' : 'text-tertiary';
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-hair px-2 py-1 text-meta md:px-3"
      data-testid="session-group"
      data-state={group.state}
    >
      {group.state === 'preparing' ? (
        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse" aria-hidden="true" />
      ) : null}
      <button
        type="button"
        data-testid="session-group-toggle"
        aria-expanded={open}
        className="min-w-0 shrink-0 break-words text-left hover:text-primary"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={tone}>{groupHeadline(group.members.length)}</span>
        <span className="ml-1.5 text-tertiary">{open ? '收起' : '展开'}</span>
      </button>
      {note !== null ? (
        <span className={`min-w-0 break-words ${group.state === 'failed' ? 'text-rust' : 'text-secondary'}`} role="status">
          {note}
        </span>
      ) : null}
      {open ? (
        <ul className="w-full space-y-0.5 pl-4 text-meta text-tertiary">
          {group.members.map((member) => (
            <li
              key={member.workspaceId}
              className="flex flex-wrap items-baseline gap-x-2"
              data-testid="session-group-member"
              data-state={member.state}
            >
              <span className="font-mono text-secondary">{member.name === '' ? '（仓库名缺失）' : member.name}</span>
              <span className={member.state === 'failed' ? 'text-rust' : member.state === 'ready' ? 'text-tertiary' : 'text-secondary'}>
                {memberStateLabel(member)}
              </span>
              {member.error ? <span className="break-words text-rust">{member.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
