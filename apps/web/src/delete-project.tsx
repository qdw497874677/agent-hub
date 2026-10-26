import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
      onDeleted?.();
      onClose();
    }
  });
  const matches = typed === project.name;
  return (
    <DialogShell title="删除项目" onClose={onClose}>
      <h2 className="mb-2 text-body text-primary">删除项目「{project.name}」</h2>
      <p className="mb-2 text-sub text-secondary">
        会删掉它的全部任务、工作日志、会话记录和画布布局，删了找不回来。还在运行的会话要先停止。
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
          {remove.isPending ? '删除中…' : '删除项目'}
        </button>
      </div>
    </DialogShell>
  );
}
