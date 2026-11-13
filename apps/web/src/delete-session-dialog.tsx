import { useState } from 'react';
import type { SessionDto } from './api.ts';
import { api } from './api.ts';
import { DANGER_BUTTON, DialogShell, SECONDARY_BUTTON } from './dialog-shell.tsx';
import { deleteSessionBody, deleteSessionErrorText, deleteSessionLabel } from './delete-session.ts';

/**
 * 「删除会话？」确认框。
 *
 * 会话没有回收站：点了就真没了。所以正文把删掉什么、留下什么写清楚，
 * 失败就地显示原因、弹窗不清空——人还能看一眼再决定重试还是取消。
 * 删除中锁住关闭（遮罩、Esc、取消都点不动），别留一个跑到一半没人管的请求。
 */
export function DeleteSessionDialog({
  session,
  opening,
  onClose,
  onDeleted
}: {
  readonly session: SessionDto;
  /** canvas.openings[id]：没起名时拿第一句提问当会话名。 */
  readonly opening: string | undefined;
  /** 关掉弹窗（取消 / Esc / 点遮罩），焦点由调用方收回「⋯」。 */
  readonly onClose: () => void;
  /** 服务端已经删掉：调用方负责把它从画布缓存里摘掉。 */
  readonly onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = deleteSessionLabel({ title: session.title, opening });

  async function remove(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteSession(session.id);
      onDeleted();
    } catch (failure) {
      setError(deleteSessionErrorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogShell
      title="删除会话？"
      testId="session-delete-dialog"
      // 删除中不给关：遮罩点和 Esc 都不该把请求留在半路上。
      onClose={busy ? () => undefined : onClose}
    >
      <h2 className="mb-2 text-body text-primary">删除会话？</h2>
      <p className="mb-3 text-sub text-secondary">{deleteSessionBody(name)}</p>
      {error ? (
        <p role="alert" data-testid="session-delete-error" className="mb-2 text-meta text-rust">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          autoFocus
          className={SECONDARY_BUTTON}
          data-testid="session-delete-cancel"
          disabled={busy}
          onClick={onClose}
        >
          取消
        </button>
        <button
          className={DANGER_BUTTON}
          data-testid="session-delete-confirm"
          disabled={busy}
          onClick={() => void remove()}
        >
          {busy ? '删除中…' : '删除'}
        </button>
      </div>
    </DialogShell>
  );
}
