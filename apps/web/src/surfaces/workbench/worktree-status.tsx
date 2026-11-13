import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDto } from '../../shell/api.ts';
import { api } from '../../shell/api.ts';
import { setupOutputTail, setupStatusLine, workspaceSetup } from './worktree-config.ts';

/**
 * 会话页标题区下面那一行（docs/design/worktree.md §7）：worktree 准备到哪一步了。
 *
 * 只在有话要说时才占位（running / failed / ready 且有日志），就绪且无日志就整行不出现——
 * 常态不该有一条「一切正常」的横幅天天占着屏幕。数据复用画布的 workspace 列表：worker
 * 在跑命令时会推动画布，不需要这里自己轮询。
 */
export function WorktreeStatusLine({ workspace, projectId }: { workspace: WorkspaceDto | undefined; projectId: string }) {
  const setup = workspaceSetup(workspace);
  const line = setupStatusLine(setup);
  const [logOpen, setLogOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: (workspaceId: string) => api.retryWorkspaceSetup(workspaceId),
    onSuccess: async () => {
      // 重跑一开始，上一次的失败输出就过期了：收起来，等新日志
      setOutputOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['canvas', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['workspaces', projectId] })
      ]);
    }
  });
  // 重试后状态回到 running，把上一次的失败输出折起来，别让人以为还在看新结果
  useEffect(() => {
    if (setup?.state === 'running') setOutputOpen(false);
  }, [setup?.state]);

  if (line === null || setup === null) return null;
  const output = setupOutputTail(setup.output);
  const hasOutput = output.trim() !== '';
  const failed = setup.state === 'failed';
  const open = failed ? outputOpen : logOpen;
  const setOpen = failed ? setOutputOpen : setLogOpen;
  const text = line.tone === 'bad' ? 'text-rust' : line.tone === 'busy' ? 'text-secondary' : 'text-tertiary';
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-hair px-2 py-1 text-meta md:px-3"
      data-testid="worktree-status"
      data-tone={line.tone}
    >
      {line.tone === 'busy' ? (
        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse" aria-hidden="true" />
      ) : null}
      <span className={`min-w-0 break-words ${text}`} role={failed || line.tone === 'busy' ? 'status' : undefined}>
        {line.text}
      </span>
      {failed ? (
        <button
          type="button"
          className="shrink-0 text-accent underline-offset-2 hover:underline disabled:text-tertiary"
          data-testid="worktree-retry"
          disabled={retry.isPending || workspace === undefined}
          onClick={() => {
            if (workspace !== undefined) retry.mutate(workspace.id);
          }}
        >
          {retry.isPending ? '重试中…' : '重试准备'}
        </button>
      ) : null}
      {hasOutput ? (
        <button
          type="button"
          className="shrink-0 text-accent underline-offset-2 hover:underline"
          data-testid="worktree-output-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {failed ? (outputOpen ? '收起输出' : '看输出') : logOpen ? '收起准备日志' : '准备日志'}
        </button>
      ) : null}
      {retry.error ? <span className="min-w-0 break-words text-rust">{retry.error.message}</span> : null}
      {open && hasOutput ? (
        <pre
          className="mt-0.5 max-h-40 w-full basis-full overflow-auto whitespace-pre-wrap break-all rounded-sm bg-card px-2 py-1 font-mono text-meta text-tertiary"
          data-testid="worktree-output"
        >
          {output}
        </pre>
      ) : null}
    </div>
  );
}
