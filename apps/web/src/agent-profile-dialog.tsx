import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SessionDto } from './api.ts';
import { api } from './api.ts';
import { DialogShell, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from './dialog-shell.tsx';

/** 把当前会话的 agent/model/选项保存成可复用的 Agent 配置。 */
export function SaveAgentProfileDialog({
  session,
  agentLabel,
  onClose,
  onSaved
}: {
  session: SessionDto;
  agentLabel: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () =>
      api.createAgentProfile({
        name: name.trim(),
        agentId: session.agentId,
        model: session.model,
        options: session.options,
        notes: notes.trim()
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['agent-profiles'] });
      onSaved();
    }
  });

  return (
    <DialogShell title="保存为 Agent 配置" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '' && !save.isPending) save.mutate();
        }}
      >
        <p className="mb-3 text-head text-primary">保存为 Agent 配置</p>
        <p className="mb-3 text-meta text-secondary">
          会保存 <span className="text-primary">{agentLabel}</span>
          {session.model ? <> · {session.model}</> : null}
          {Object.keys(session.options).length > 0 ? <> · {Object.keys(session.options).length} 个选项</> : null}
          。下次派生会话时可以直接套用。
        </p>
        <label className="mb-1 block text-meta text-secondary" htmlFor="profile-name">名字</label>
        <input
          id="profile-name"
          autoFocus
          className={`mb-3 ${INPUT}`}
          placeholder="比如：OpenCode 探索模式"
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <label className="mb-1 block text-meta text-secondary" htmlFor="profile-notes">备注（可留空）</label>
        <textarea
          id="profile-notes"
          className={`mb-4 h-20 resize-none ${INPUT}`}
          placeholder="什么时候用它"
          maxLength={2000}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        {save.error ? <p className="mb-2 text-meta text-rust">{(save.error as Error).message}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
            取消
          </button>
          <button type="submit" className={PRIMARY_BUTTON} disabled={name.trim() === '' || save.isPending}>
            {save.isPending ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
