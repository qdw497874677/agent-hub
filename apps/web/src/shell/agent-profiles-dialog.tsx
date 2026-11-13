import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentDto, AgentProfileDto } from './api.ts';
import { api } from './api.ts';
import { DialogShell, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from './dialog-shell.tsx';

/**
 * Agent 配置的管理面板：改名、改模型/备注、复制、删除。
 * 配置是“启动组合”，所以不在这里改 options 的原始 JSON；派生时会按运行时
 * 当前上报的 optionSpec 检查兼容性。
 */
export function AgentProfilesDialog({
  agents,
  onClose
}: {
  agents: readonly AgentDto[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ['agent-profiles'], queryFn: () => api.agentProfiles(), retry: false });
  const [editing, setEditing] = useState<AgentProfileDto | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [model, setModel] = useState('');
  const [notes, setNotes] = useState('');

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['agent-profiles'] });
  };

  const save = useMutation({
    mutationFn: () => {
      if (!editing) throw new Error('没有正在编辑的配置');
      return api.updateAgentProfile(editing.id, {
        name: name.trim(),
        agentId,
        model,
        options: editing.options,
        notes: notes.trim()
      });
    },
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    }
  });

  const duplicate = useMutation({
    mutationFn: (profile: AgentProfileDto) =>
      api.createAgentProfile({
        name: `${profile.name} 副本`.slice(0, 80),
        agentId: profile.agentId,
        model: profile.model,
        options: profile.options,
        notes: profile.notes
      }),
    onSuccess: refresh
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAgentProfile(id),
    onSuccess: async () => {
      setConfirmDelete(null);
      await refresh();
    }
  });

  const startEdit = (profile: AgentProfileDto) => {
    setEditing(profile);
    setName(profile.name);
    setAgentId(profile.agentId);
    setModel(profile.model);
    setNotes(profile.notes);
    save.reset();
  };

  const selectedAgent = agents.find((candidate) => candidate.id === agentId);
  const optionIds = new Set((selectedAgent?.options ?? []).map((option) => option.id));
  const unsupported = editing ? Object.keys(editing.options).filter((id) => !optionIds.has(id)) : [];

  return (
    <DialogShell title="Agent 配置" onClose={onClose} wide>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <p className="text-head text-primary">Agent 配置</p>
          <p className="mt-1 text-meta text-secondary">保存的是 agent、模型和启动选项的组合；改这里不会影响已经在跑的会话。</p>
        </div>
        <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
          关闭
        </button>
      </div>

      {profiles.isLoading ? <p className="text-meta text-secondary">加载中…</p> : null}
      {profiles.error ? <p className="text-meta text-rust">{(profiles.error as Error).message}</p> : null}
      {!profiles.isLoading && (profiles.data ?? []).length === 0 ? (
        <p className="rounded border border-hair p-3 text-meta text-secondary">
          还没有保存的配置。在会话的“更多”里选“保存为 Agent 配置”，或在派生会话时保存。
        </p>
      ) : null}

      <ul className="grid gap-2" data-testid="agent-profile-list">
        {(profiles.data ?? []).map((profile) => (
          <li key={profile.id} className="rounded border border-hair p-3" data-testid="agent-profile-row">
            {editing?.id === profile.id ? (
              <form
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (name.trim() !== '' && agentId !== '' && !save.isPending) save.mutate();
                }}
              >
                <label className="text-meta text-secondary" htmlFor="profile-edit-name">名字</label>
                <input
                  id="profile-edit-name"
                  className={INPUT}
                  maxLength={80}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <label className="text-meta text-secondary" htmlFor="profile-edit-agent">Agent</label>
                <select
                  id="profile-edit-agent"
                  className={INPUT}
                  value={agentId}
                  onChange={(event) => {
                    const next = event.target.value;
                    setAgentId(next);
                    const candidate = agents.find((item) => item.id === next);
                    if (candidate && !candidate.models.includes(model)) setModel(candidate.defaultModel);
                  }}
                >
                  {agents.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </option>
                  ))}
                </select>
                <label className="text-meta text-secondary" htmlFor="profile-edit-model">模型</label>
                <select id="profile-edit-model" className={INPUT} value={model} onChange={(event) => setModel(event.target.value)}>
                  <option value="">运行时默认</option>
                  {(selectedAgent?.models ?? []).map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {candidate}
                    </option>
                  ))}
                  {model !== '' && !(selectedAgent?.models ?? []).includes(model) ? (
                    <option value={model}>{model}（当前运行时未上报）</option>
                  ) : null}
                </select>
                <label className="text-meta text-secondary" htmlFor="profile-edit-notes">备注</label>
                <textarea
                  id="profile-edit-notes"
                  className={`h-20 resize-none ${INPUT}`}
                  maxLength={2000}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                />
                {unsupported.length > 0 ? (
                  <p className="text-meta text-rust">
                    这个配置带有当前 {selectedAgent?.label ?? 'agent'} 不认识的选项：{unsupported.join('、')}。派生时会忽略它们。
                  </p>
                ) : null}
                {save.error ? <p className="text-meta text-rust">{(save.error as Error).message}</p> : null}
                <div className="flex justify-end gap-2">
                  <button type="button" className={SECONDARY_BUTTON} onClick={() => setEditing(null)}>
                    取消
                  </button>
                  <button type="submit" className={PRIMARY_BUTTON} disabled={name.trim() === '' || agentId === '' || save.isPending}>
                    {save.isPending ? '保存中…' : '保存'}
                  </button>
                </div>
              </form>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-body text-primary">{profile.name}</p>
                    <p className="mt-1 text-meta text-secondary">
                      {profile.agentId}
                      {profile.model ? ` · ${profile.model}` : ''}
                      {Object.keys(profile.options).length > 0 ? ` · ${Object.keys(profile.options).length} 个选项` : ''}
                    </p>
                    {profile.notes ? <p className="mt-1 text-meta text-tertiary">{profile.notes}</p> : null}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button type="button" className={SECONDARY_BUTTON} onClick={() => startEdit(profile)}>
                      编辑
                    </button>
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      disabled={duplicate.isPending}
                      onClick={() => duplicate.mutate(profile)}
                    >
                      复制
                    </button>
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      disabled={remove.isPending}
                      onClick={() => setConfirmDelete(profile.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>
                {confirmDelete === profile.id ? (
                  <div className="mt-2 flex flex-wrap items-center justify-end gap-2 border-t border-hair pt-2">
                    <span className="text-meta text-rust">确定删除这个配置？</span>
                    <button type="button" className={SECONDARY_BUTTON} onClick={() => setConfirmDelete(null)}>
                      取消
                    </button>
                    <button type="button" className={PRIMARY_BUTTON} disabled={remove.isPending} onClick={() => remove.mutate(profile.id)}>
                      {remove.isPending ? '删除中…' : '确认删除'}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
      {remove.error ? <p className="mt-2 text-meta text-rust">{(remove.error as Error).message}</p> : null}
      {duplicate.error ? <p className="mt-2 text-meta text-rust">{(duplicate.error as Error).message}</p> : null}
    </DialogShell>
  );
}
