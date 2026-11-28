import { useState } from 'react';
import { statusStyle } from '../../atoms/status.tsx';
import type { CanvasDto, SessionDto } from '../../shell/api.ts';
import { sessionGroupId } from '../../shell/api.ts';
import { Sheet } from '../../shell/dialog-shell.tsx';
import { workdirLabels, workdirSessionLabel } from './workdir-model.ts';

/** A switcher never infers scope from a directory name or a missing workspace. */
export function SessionSwitcher({ canvas, session, compact, status, lastSeq, onOpen }: {
  canvas: CanvasDto; session: SessionDto; compact: boolean; status: SessionDto['status']; lastSeq: number; onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const group = sessionGroupId(session);
  const workspace = session.workspaceId && canvas.workspaces.find((item) => item.id === session.workspaceId);
  const peers = group
    ? canvas.sessions.filter((item) => sessionGroupId(item) === group && item.workerId === session.workerId)
    : workspace && !workspace.groupId
      ? canvas.sessions.filter((item) => !sessionGroupId(item) && item.workspaceId === workspace.id && item.workerId === session.workerId)
      : [];
  if (!peers.length) return null;
  const labels = workdirLabels(peers.map((item) => workdirSessionLabel(item.id, item, canvas.tasks.find((task) => task.id === item.taskId), false)));
  const itemStatus = (item: SessionDto) => statusStyle(item.id === session.id ? status : item.status, item.id === session.id ? lastSeq : item.lastSeq);
  const select = (id: string) => { setOpen(false); if (id !== session.id) onOpen(id); };
  return <div data-testid="session-switcher" className={compact ? 'flex shrink-0 items-center' : 'flex min-w-0 shrink-0 items-stretch border-b border-hair bg-card'}>
    {!compact ? <div role="navigation" aria-label="同工作目录会话" className="flex min-w-0 flex-1 overflow-x-auto">
      {peers.map((item, index) => { const style = itemStatus(item); const selected = item.id === session.id; return <button key={item.id} type="button" data-testid="session-scope-item" data-session-id={item.id} aria-current={selected ? 'page' : undefined} onClick={() => select(item.id)} className={`flex min-h-10 max-w-48 shrink-0 items-center gap-2 border-b-2 px-3 text-sub ${selected ? 'border-sage bg-selected text-primary' : 'border-transparent text-secondary hover:bg-hover'}`}><span className={`size-2 shrink-0 ${style.dot} ${style.shape}`} /><span className="truncate">{labels[index]}</span></button>; })}
    </div> : null}
    <button type="button" data-testid="session-scope-trigger" aria-label={`切换会话，共 ${peers.length} 个`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className="min-h-[44px] min-w-[44px] shrink-0 rounded-sm px-1 font-mono text-meta text-secondary hover:bg-hover">{peers.length} ▾</button>
    {open ? <Sheet title="切换会话" testId="session-scope-picker" onClose={() => setOpen(false)}>{peers.map((item, index) => { const style = itemStatus(item); const selected = item.id === session.id; return <button key={item.id} type="button" data-testid="session-scope-item" data-session-id={item.id} aria-current={selected ? 'page' : undefined} onClick={() => select(item.id)} className={`flex min-h-[44px] w-full items-center gap-3 rounded-md px-3 text-left text-sub ${selected ? 'bg-selected text-primary' : 'text-secondary hover:bg-hover'}`}><span className={`size-2 shrink-0 ${style.dot} ${style.shape}`} /><span className="min-w-0 flex-1 truncate">{labels[index]}</span><span className="shrink-0 text-meta text-tertiary">{selected ? '当前 · ' : ''}{style.label}</span></button>; })}</Sheet> : null}
  </div>;
}
