import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CanvasDto, SessionDto } from '../../shell/api.ts';
import { api, providersApi } from '../../shell/api.ts';
import { projectKeys } from '../../shell/query-keys.ts';
import { DialogShell, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';
import { useWorkers } from '../../shell/workers.tsx';
import { carriedProtocol, startBlockReason } from '../../shell/harness-gate.ts';
import { WorkspaceChooser, choiceReady, longLivedRequest, useWorkspaceViews, type WorkspaceChoice } from './workspace-chooser.tsx';

/**
 * 换个地方继续（docs/design/workspaces.md §7）。说法要诚实：agent 自己的会话状态搬不走，
 * 搬过去的是平台记下的对话摘要和任务工作日志——在目标工作目录开一条新会话，挂成这条的分叉。
 * 代码不会自己过去：git 工作目录可以先提交 WIP 并推送分支，否则改动留在原处。
 */
/** 没说过话的会话没有可搬的上下文。 */
export function canContinueElsewhere(session: Pick<SessionDto, 'lastSeq'>): boolean {
  return session.lastSeq > 0;
}
export const CONTINUE_DISABLED_HINT = '这条会话还没有内容';

/** 对话框本体：检查器里的按钮、专注对话头部的「⋯」菜单都打开它。 */
export function ContinueDialog({
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
  // 这条会话用的可能是 Hub 模型：服务端继续时把它原样带过去（use-cases/continue-elsewhere.ts）。
  // 只看这条会话自己的模型，不在这里开放换模型；协议从项目能用的 Hub 模型清单里查。
  const hubModels = useQuery({
    queryKey: ['hub-models', canvas.project.id],
    queryFn: () => providersApi.modelsExplained({ projectId: canvas.project.id }),
    retry: false
  });
  const carried = carriedProtocol(session.model, hubModels.data?.providers ?? []);
  // 目标机器在、但这台上的 agent 现在起不来（探测失败 / 离线）：按钮别装作能开。
  const blocked =
    machine === null ? null : startBlockReason(workers.byId(machine), session.agentId, session.model, carried);
  const agentLabel = canvas.agents.find((candidate) => candidate.id === session.agentId)?.label ?? session.agentId;

  async function go() {
    if (!choice || machine === null) return;
    setBusy(true);
    setError(null);
    try {
      let target: { kind: 'workspace'; workspaceId: string } | { kind: 'temporary'; workerId: string | null };
      if (choice.type === 'existing') target = { kind: 'workspace', workspaceId: choice.workspaceId };
      else if (choice.type === 'new_temporary') target = { kind: 'temporary', workerId: machine };
      else if (choice.type === 'new_worktree') {
        // 隔离 worktree：先按项目配置在目标机器上现建（准备命令跑完），再把它当普通空间继续
        const made = await api.createWorkspace(canvas.project.id, { workerId: machine, kind: 'temporary', taskId: session.taskId ?? '', mode: 'isolated' });
        setChoice({ type: 'existing', workspaceId: made.id });
        target = { kind: 'workspace', workspaceId: made.id };
      } else if (choice.type === 'new_long_lived') {
        const made = await api.createWorkspace(canvas.project.id, longLivedRequest(machine, choice));
        setChoice({ type: 'existing', workspaceId: made.id });
        target = { kind: 'workspace', workspaceId: made.id };
      } else {
        // 组合工作目录只在派生时能选（这里 groups=false 不显示），防御一下
        return;
      }
      const created = await api.continueElsewhere(session.id, { target, saveWip: saveWip && from?.isGit === true });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectKeys.canvas(canvas.project.id) }),
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
        会新开一条会话，并带上这里的摘要。原会话不受影响。
      </p>
      <WorkspaceChooser
        canvas={canvas}
        taskId={session.taskId ?? ''}
        agentId={session.agentId}
        workers={workers.list}
        machine={machine}
        onMachine={setMachine}
        choice={choice}
        onChoice={setChoice}
        hubProtocols={carried === null ? [] : [carried]}
      />
      {from?.isGit ? (
        <label className="mb-3 flex items-start gap-2 text-meta text-secondary">
          <input type="checkbox" className="mt-0.5" checked={saveWip} onChange={(event) => setSaveWip(event.target.checked)} />
          <span>
            先提交 WIP 并推送分支{from.branch ? <span className="font-mono"> {from.branch}</span> : null}
            <span className="block text-tertiary">
              新开临时工作目录时会直接检出这个分支。不勾：代码改动留在原来的工作目录里。
            </span>
          </span>
        </label>
      ) : (
        <p className="mb-3 text-meta text-tertiary">原来的工作目录不是 git 仓库：文件不会搬过去，改动留在原处。</p>
      )}
      {same ? <p className="mb-2 text-meta text-rust">会话已经在这个工作目录里了，换一个。</p> : null}
      {blocked === null ? null : (
        <p data-testid="continue-hint" className="mb-2 text-meta text-rust">
          {blocked === '机器不在线' ? (
            <>这台机器现在不在线。机器和目录都还在，等它回来再继续。</>
          ) : (
            <>这台机器上的 {agentLabel} 现在用不了{blocked ? `：${blocked}` : ''}。机器和目录都还在，等它恢复再继续。</>
          )}
        </p>
      )}
      {error ? <p className="mb-2 text-meta text-rust">{error}</p> : null}
      <div className="sticky bottom-0 -mx-1 flex justify-end gap-2 bg-panel px-1 pb-[env(safe-area-inset-bottom)] pt-2">
        <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={busy || !choiceReady(choice) || machine === null || same || blocked !== null}
          onClick={() => void go()}
        >
          {busy ? '交接中…' : '继续'}
        </button>
      </div>
    </DialogShell>
  );
}
