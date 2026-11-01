import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contextApi, type ProjectContextDto } from './api.ts';
import { SECONDARY_BUTTON } from './dialog-shell.tsx';

/**
 * 项目设置 · 上下文策略（ADR 0020 §8）：项目默认 + 启用列表 + 角色层。
 * 选择顺序：会话 > 角色 > 项目 > hub。改动从会话的下一代生效。
 */
export function ProjectContext({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const client = useQueryClient();
  const key = ['context', 'project', projectId];
  const view = useQuery({ queryKey: key, queryFn: () => contextApi.project(projectId) });
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState('');
  const done = {
    onSuccess: (next: ProjectContextDto) => {
      setError(null);
      client.setQueryData(key, next);
    },
    onError: (e: Error) => setError(e.message)
  };
  const saveProject = useMutation({ mutationFn: (input: { strategy: string; enabled: string[] }) => contextApi.setProject(projectId, input), ...done });
  const saveRole = useMutation({ mutationFn: (input: { role: string; strategy: string | null }) => contextApi.setRole(projectId, input.role, input.strategy), ...done });
  const data = view.data;
  if (!data) return null;
  const title = (id: string) => data.installed.find((s) => s.id === id)?.title ?? id;
  return (
    <section data-testid="project-context" className="mb-4">
      <h3 className="mb-1 text-sub text-primary">上下文策略</h3>
      <p className="mb-2 text-meta text-tertiary">会话上下文快满时怎么处理。优先级：会话 &gt; 角色 &gt; 项目 &gt; hub 默认；改了从下一代会话生效。</p>
      <label className="mb-1 flex items-center gap-2 text-meta text-secondary">
        项目默认
        <select
          data-testid="project-context-strategy"
          className="rounded border border-hair bg-surface px-1 py-0.5"
          value={data.strategy}
          disabled={!canEdit || saveProject.isPending}
          onChange={(e) => saveProject.mutate({ strategy: e.target.value, enabled: [...new Set([...data.enabled, e.target.value])] })}
        >
          {data.installed.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        {data.inherited ? <span className="text-tertiary">（跟随 hub）</span> : null}
      </label>
      <p className="mb-1 text-meta text-tertiary">
        启用：{data.enabled.map(title).join('、')}
        {data.candidates.length > 0 ? ` · 候选（还不能选）：${data.candidates.map((c) => `${c.title}（${c.note}）`).join('、')}` : ''}
      </p>
      <p className="mb-1 text-meta text-secondary">角色</p>
      {data.roles.length === 0 ? <p className="text-meta text-tertiary">没有角色单独设置，全跟随项目。</p> : null}
      <ul className="mb-1 space-y-0.5" data-testid="project-context-roles">
        {data.roles.map((r) => (
          <li key={r.role} className="flex items-center gap-2 text-meta text-secondary">
            <span className="font-mono">@{r.role}</span>
            <span>{title(r.strategy)}</span>
            {canEdit ? (
              <button type="button" className={SECONDARY_BUTTON} onClick={() => saveRole.mutate({ role: r.role, strategy: null })}>
                改回跟随项目
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = role.trim().replace(/^@/, '');
            if (name) saveRole.mutate({ role: name, strategy: data.strategy }, { onSuccess: () => setRole('') });
          }}
        >
          <input
            data-testid="project-context-role-input"
            className="w-32 rounded border border-hair bg-surface px-1 py-0.5 text-meta"
            placeholder="角色名"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
          <button type="submit" className={SECONDARY_BUTTON} data-testid="project-context-role-add">
            给角色单独设置
          </button>
        </form>
      ) : null}
      {error ? <p className="mt-1 text-meta text-accent">{error}</p> : null}
    </section>
  );
}
