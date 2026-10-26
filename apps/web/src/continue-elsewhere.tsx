import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CanvasDto, SessionDto } from './api.ts';
import { api } from './api.ts';
import { DialogShell, PRIMARY_BUTTON, SECONDARY_BUTTON } from './dialog-shell.tsx';
import { useWorkers } from './workers.tsx';
import { WorkspaceChooser, choiceReady, useWorkspaceViews, type WorkspaceChoice } from './workspace-chooser.tsx';

/**
 * 换个地方继续（docs/design/workspaces.md §7）。说法要诚实：agent 自己的会话状态搬不走，
 * 搬过去的是平台记下的对话摘要和任务工作日志——在目标工作空间开一条新会话，挂成这条的分叉。
 * 代码不会自己过去：git 工作空间可以先提交 WIP 并推送分支，否则改动留在原处。
 */
export function ContinueElsewhere({
  canvas,
  session,
  onDone
}: {
  canvas: CanvasDto;
  session: SessionDto;
  onDone: (created: SessionDto) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mb-3" aria-label="换个地方继续">
      <button
        className="rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-sage hover:text-sage disabled:opacity-40"
        disabled={session.lastSeq === 0}
        title={session.lastSeq === 0 ? '这条会话还没有内容' : undefined}
        onClick={() => setOpen(true)}
      >
        换个地方继续…
      </button>
      {open ? (
        <ContinueDialog
          canvas={canvas}
          session={session}
          onClose={() => setOpen(false)}
          onDone={(created) => {
            setOpen(false);
            onDone(created);
          }}
        />
      ) : null}
    </section>
  );
}

function ContinueDialog({
  canvas,
  session,
  onClose,
  onDone
}: {
  canvas: CanvasDto;
  session: SessionDto;
  onClose: () => void;
  onDone: (created: SessionDto) => void;
}) {
  const workers = useWorkers();
  const queryClient = useQueryClient();
  const views = useWorkspaceViews(canvas.project.id);
  const [machine, setMachine] = useState<string | null>(null);
  const [choice, setChoice] = useState<WorkspaceChoice | null>(null);
  const [saveWip, setSaveWip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = views.data?.find(({ workspace }) => workspace.id === session.workspaceId)?.workspace ?? null;
  const same = choice?.type === 'existing' && choice.workspaceId === session.workspaceId;

  async function go() {
    if (!choice || machine === null) return;
    setBusy(true);
    setError(null);
    try {
      let target: { kind: 'workspace'; workspaceId: string } | { kind: 'temporary'; workerId: string | null };
      if (choice.type === 'existing') target = { kind: 'workspace', workspaceId: choice.workspaceId };
      else if (choice.type === 'new_temporary') target = { kind: 'temporary', workerId: machine };
      else {
        const made = await api.createWorkspace(canvas.project.id, {
          workerId: machine,
          kind: 'long_lived',
          mode: choice.mode,
          ...(choice.mode === 'link' && choice.path ? { path: choice.path } : {})
        });
        setChoice({ type: 'existing', workspaceId: made.id });
        target = { kind: 'workspace', workspaceId: made.id };
      }
      const created = await api.continueElsewhere(session.id, { target, saveWip: saveWip && from?.isGit === true });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['canvas', canvas.project.id] }),
        queryClient.invalidateQueries({ queryKey: ['workspaces', canvas.project.id] })
      ]);
      onDone(created);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogShell title="换个地方继续" onClose={onClose}>
      <p className="mb-1 text-head text-primary">换个地方继续</p>
      <p className="mb-3 text-meta text-tertiary">
        agent 自己的会话状态带不过去：会在你选的地方新开一条会话，把这里的对话摘要和任务工作日志作为第一条消息发过去，并挂成这条的分叉。
      </p>
      <WorkspaceChooser
        canvas={canvas}
        taskId={session.taskId}
        agentId={session.agentId}
        workers={workers.list}
        machine={machine}
        onMachine={setMachine}
        choice={choice}
        onChoice={setChoice}
      />
      {from?.isGit ? (
        <label className="mb-3 flex items-start gap-2 text-meta text-secondary">
          <input type="checkbox" className="mt-0.5" checked={saveWip} onChange={(event) => setSaveWip(event.target.checked)} />
          <span>
            先提交 WIP 并推送分支{from.branch ? <span className="font-mono"> {from.branch}</span> : null}
            <span className="block text-tertiary">
              新开临时工作空间时会直接检出这个分支。不勾：代码改动留在原来的工作空间里。
            </span>
          </span>
        </label>
      ) : (
        <p className="mb-3 text-meta text-tertiary">原来的工作空间不是 git 仓库：文件不会搬过去，改动留在原处。</p>
      )}
      {same ? <p className="mb-2 text-meta text-rust">会话已经在这个工作空间里了，换一个。</p> : null}
      {error ? <p className="mb-2 text-meta text-rust">{error}</p> : null}
      <div className="sticky bottom-0 -mx-1 flex justify-end gap-2 bg-panel px-1 pb-[env(safe-area-inset-bottom)] pt-2">
        <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={busy || !choiceReady(choice) || machine === null || same}
          onClick={() => void go()}
        >
          {busy ? '交接中…' : '继续'}
        </button>
      </div>
    </DialogShell>
  );
}
