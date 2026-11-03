import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rewindApi } from './api.ts';
import { DialogShell, PRIMARY_BUTTON, SECONDARY_BUTTON } from './dialog-shell.tsx';

/**
 * 「⋯ → 从这里重来」（ADR 0027 阶段 4）：从这条消息之前分叉一条新会话（原会话不动），原消息回填到新会话输入框。
 * 连文件一起回滚只给临时工作空间（D9）；不能时把原因摆出来，而不是藏掉选项。
 */
export function RewindDialog({ sessionId, promptSeq, onClose, onDone }: {
  sessionId: string;
  promptSeq: number;
  onClose: () => void;
  onDone: (sessionId: string, prompt: string) => void;
}) {
  const queries = useQueryClient();
  const preview = useQuery({ queryKey: ['rewind', sessionId, promptSeq], queryFn: () => rewindApi.preview(sessionId, promptSeq), retry: false, staleTime: 0 });
  const [files, setFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = preview.data;

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const out = await rewindApi.rewind(sessionId, promptSeq, files);
      void queries.invalidateQueries({ queryKey: ['files', sessionId] });
      onDone(out.session.id, out.prompt);
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  }

  return (
    <DialogShell title="从这里重来" onClose={onClose}>
      <div className="flex flex-col gap-3" data-testid="rewind-dialog">
        <h2 className="text-body text-primary">从这里重来</h2>
        {p ? (
          <blockquote className="line-clamp-3 break-words border-l-2 border-hair pl-2 text-sub text-secondary">{p.prompt}</blockquote>
        ) : preview.error ? (
          <p role="alert" className="text-meta text-rust">{(preview.error as Error).message}</p>
        ) : (
          <p className="text-meta text-tertiary">读取中…</p>
        )}
        {p?.mode === 'native' ? (
          <p className="rounded-md bg-sage/10 px-2 py-1.5 text-meta text-sage" data-testid="rewind-mode" data-mode="native">
            ✓ 用 {p.agentLabel} 自带的分支：新会话逐字保留这条消息之前的上下文，不用摘要
          </p>
        ) : p?.mode === 'summary' ? (
          <p className="rounded-md bg-ochre/10 px-2 py-1.5 text-meta text-ochre" data-testid="rewind-mode" data-mode="summary">
            新会话会收到一段之前对话的摘要（{p.modeReason ?? `${p.agentLabel} 不支持从中间某条消息分叉`}）
          </p>
        ) : null}
        <fieldset className="flex flex-col gap-2" disabled={!p || busy}>
          <label className="flex items-start gap-2 text-sub text-primary">
            <input type="radio" name="rewind" className="mt-1" checked={!files} onChange={() => setFiles(false)} />
            <span>
              只回滚对话
              <span className="block text-meta text-tertiary">新开一条会话，从这条消息之前接着聊；工作区文件保持现在的样子。</span>
            </span>
          </label>
          <label className={`flex items-start gap-2 text-sub ${p?.filesAllowed ? 'text-primary' : 'text-tertiary'}`}>
            <input type="radio" name="rewind" className="mt-1" checked={files} disabled={!p?.filesAllowed} onChange={() => setFiles(true)} data-testid="rewind-files" />
            <span>
              连文件一起回滚
              <span className="block text-meta text-tertiary" data-testid="rewind-files-note">
                {p?.filesAllowed
                  ? `工作区恢复到这条消息之前，撤掉之后 ${p.turnsAfter} 轮的改动；恢复前会先存一张快照。`
                  : (p?.filesBlocked ?? '')}
              </span>
            </span>
          </label>
        </fieldset>
        <p className="text-meta text-tertiary">原会话不会被改动，随时能回去看。</p>
        {error ? <p role="alert" className="break-words text-meta text-rust">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>取消</button>
          <button type="button" className={PRIMARY_BUTTON} disabled={!p || busy} onClick={() => void go()} data-testid="rewind-go">
            {busy ? '正在重来…' : '重来'}
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
