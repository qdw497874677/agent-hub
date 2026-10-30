import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto } from './api.ts';
import { api } from './api.ts';
import { DialogShell, INPUT, SECONDARY_BUTTON } from './dialog-shell.tsx';

/**
 * 删除项目的确认框（GitHub 式：把项目名再输一遍才能点）。
 * 只删 hub 里的记录；磁盘上的目录一律保留，这句话要说在明处。
 */
export function DeleteProjectDialog({ project, onClose, onDeleted }: { project: ProjectDto; onClose: () => void; onDeleted?: () => void }) {
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState('');
  const remove = useMutation({
    mutationFn: () => api.deleteProject(project.id, typed),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['home'] });
      await queryClient.invalidateQueries({ queryKey: ['trash'] });
      onDeleted?.();
      onClose();
    }
  });
  const matches = typed === project.name;
  return (
    <DialogShell title="删除项目" onClose={onClose}>
      <h2 className="mb-2 text-body text-primary">删除项目「{project.name}」</h2>
      <p className="mb-2 text-sub text-secondary">
        项目会进回收站：从列表里消失，任务、会话记录都还在，随时能在首页「回收站」里还原；在回收站里「彻底删除」才会真的删掉。还在运行的会话要先停止。
      </p>
      <p className="mb-3 text-sub text-secondary">
        磁盘上的文件不会动：工作空间的目录都原样保留（要清理临时工作空间，到项目设置里删）。
      </p>
      <label className="mb-1 block text-meta text-tertiary" htmlFor="delete-project-name">
        输入项目名 <span className="font-mono text-secondary">{project.name}</span> 确认
      </label>
      <input
        id="delete-project-name"
        className={INPUT}
        value={typed}
        autoFocus
        autoComplete="off"
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && matches && !remove.isPending) remove.mutate();
        }}
      />
      {remove.error ? <p className="mt-2 text-meta text-rust">{remove.error.message}</p> : null}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button className={SECONDARY_BUTTON} onClick={onClose}>
          取消
        </button>
        <button
          className="rounded-sm bg-rust px-3 py-1.5 text-sub text-primary hover:brightness-110 disabled:opacity-40"
          disabled={!matches || remove.isPending}
          onClick={() => remove.mutate()}
        >
          {remove.isPending ? '删除中…' : '移到回收站'}
        </button>
      </div>
    </DialogShell>
  );
}

/** 首页左栏的回收站：我能还原的已删除项目（团队 owner 看全团队，成员看自己建的）。 */
export function TrashList() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const trash = useQuery({ queryKey: ['trash'], queryFn: api.trash });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['trash'] });
    await queryClient.invalidateQueries({ queryKey: ['home'] });
  };
  const restore = useMutation({ mutationFn: (id: string) => api.restoreProject(id), onSuccess: refresh });
  const purge = useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => api.purgeProject(id, name), onSuccess: refresh });
  const items = trash.data ?? [];
  if (items.length === 0) return null;
  const error = restore.error ?? purge.error;
  return (
    <div className="mb-4" data-testid="trash">
      <button className="px-2 text-meta text-tertiary hover:text-secondary" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        回收站（{items.length}）{open ? '▾' : '▸'}
      </button>
      {open ? (
        <ul className="mt-1 space-y-0.5">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-1 px-2 py-0.5">
              <span className="min-w-0 flex-1 truncate text-sub text-tertiary line-through">{item.name}</span>
              <button className="text-meta text-secondary hover:text-accent" disabled={restore.isPending} onClick={() => restore.mutate(item.id)}>
                还原
              </button>
              <button
                className="text-meta text-tertiary hover:text-rust"
                disabled={purge.isPending}
                onClick={() => {
                  const typed = window.prompt(`彻底删除「${item.name}」？任务和会话记录都会删掉，找不回来。输入项目名确认：`);
                  if (typed !== null) purge.mutate({ id: item.id, name: typed });
                }}
              >
                彻底删除
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="px-2 text-meta text-rust">{error.message}</p> : null}
    </div>
  );
}
