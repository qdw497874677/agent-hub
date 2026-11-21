import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SessionDto } from './api.ts';
import { api } from './api.ts';
import { DialogShell, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from './dialog-shell.tsx';

/**
 * 等运行时把本会话的可调项报上来。超时只是兜底：agent 报了有选项、但运行时一直没报时，
 * 不把用户永远卡在弹窗里。
 */
const OPTIONS_WAIT_MS = 30_000;
const OPTIONS_POLL_MS = 500;

/** 只是「还没上报」，不是「没有选项」：agent 的目录里有选项，而会话还没拿到清单。 */
function waitingForOptions(session: SessionDto, expectsOptions: boolean): boolean {
  return expectsOptions && session.optionSpec.length === 0 && session.status === 'running';
}

/** 把当前会话的 agent/model/选项保存成可复用的 Agent 配置。 */
export function SaveAgentProfileDialog({
  session,
  agentLabel,
  expectsOptions,
  onClose,
  onSaved
}: {
  session: SessionDto;
  agentLabel: string;
  /** agent 有可调项（descriptor.options 非空）：保存前等运行时把本会话的选项报上来。 */
  expectsOptions: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [latest, setLatest] = useState(session);
  const [gaveUp, setGaveUp] = useState(false);
  const queryClient = useQueryClient();

  const waiting = waitingForOptions(latest, expectsOptions);
  const locked = waiting && !gaveUp;

  // 选项上报不走画布刷新（它不产生流事件），所以弹窗自己轮询这一条会话。
  useEffect(() => {
    if (!waiting) return;
    let alive = true;
    const read = () => {
      void api.session(session.id).then((next) => {
        if (alive) setLatest(next);
      }).catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, OPTIONS_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [waiting, session.id]);

  // 会话换了就重新来；30 秒还没等到，允许用户带着已有数据保存。
  useEffect(() => {
    setLatest(session);
    setGaveUp(false);
    const timer = window.setTimeout(() => setGaveUp(true), OPTIONS_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [session.id]);

  const save = useMutation({
    mutationFn: async () => {
      // 提交前再读一次：轮询可能刚好落后于运行时，也可能已经停顿在超时兜底上。
      const fresh = await api.session(session.id).catch(() => latest);
      return api.createAgentProfile({
        name: name.trim(),
        agentId: fresh.agentId,
        model: fresh.model,
        options: fresh.options,
        notes: notes.trim()
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['agent-profiles'] });
      onSaved();
    }
  });

  return (
    <DialogShell title="保存为启动预设" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '' && !save.isPending && !locked) save.mutate();
        }}
      >
        <p className="mb-3 text-head text-primary">保存为启动预设</p>
        <p className="mb-3 text-meta text-secondary">
          会保存 <span className="text-primary">{agentLabel}</span>
          {latest.model ? <> · {latest.model}</> : null}
          {Object.keys(latest.options).length > 0 ? <> · {Object.keys(latest.options).length} 个选项</> : null}
          。下次派生会话时可以直接套用。
        </p>
        {waiting ? (
          <p className="mb-3 text-meta text-secondary">
            {gaveUp ? '运行时选项还没上报；现在保存不会带上选项。' : '运行时选项还没上报，拿到后就能保存。'}
          </p>
        ) : null}
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
          <button
            type="submit"
            className={PRIMARY_BUTTON}
            disabled={name.trim() === '' || save.isPending || locked}
          >
            {save.isPending ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
