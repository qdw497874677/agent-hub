import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, connectorApi, type BindingDto, type TriggerRunDto } from './api.ts';
import { formatRoute } from './route.ts';
import { INPUT, SMALL, DANGER, errorText } from './admin/shared.tsx';

/**
 * Bot 页里每个 bot 的「关联项目」和「触发」（ADR 0032 R1）。
 * 关联项目 = bot 能看见 / 建任务的项目（默认项目是定义它的那个，总在里面）。
 * 触发只能由人在这里建；timer 最短 5 分钟、默认 15；连续失败 5 次自动暂停。
 */
const STATE: Record<TriggerRunDto['state'], string> = { waiting: '等待中', delivered: '已投递', done: '完成', failed: '失败', timeout: '超时', skipped: '跳过' };
const time = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

export function BotConnectors({ projectId, name }: { projectId: string; name: string }) {
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-hair pt-2" data-testid="bot-connectors">
      <AgentProjects projectId={projectId} name={name} />
      <Triggers projectId={projectId} name={name} />
    </div>
  );
}

function AgentProjects({ projectId, name }: { projectId: string; name: string }) {
  const qc = useQueryClient();
  const key = ['agent-projects', projectId, name];
  const all = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const mine = useQuery({ queryKey: key, queryFn: () => connectorApi.projects(projectId, name) });
  const save = useMutation({ mutationFn: (ids: string[]) => connectorApi.setProjects(projectId, name, ids), onSuccess: () => qc.invalidateQueries({ queryKey: key }) });
  const linked = new Set(mine.data?.projectIds ?? []);
  const toggle = (id: string) => { const next = new Set(linked); if (next.has(id)) next.delete(id); else next.add(id); save.mutate([...next]); };
  return (
    <div data-testid="agent-projects">
      <p className="text-meta text-secondary">关联项目 <span className="text-tertiary">· 它能看见、能建任务的项目；没关联的看不见</span></p>
      <div className="mt-1 flex flex-wrap gap-1">
        {(all.data ?? []).map((p) => {
          const isDefault = p.id === projectId;
          const on = isDefault || linked.has(p.id);
          return (
            <button key={p.id} type="button" disabled={isDefault || save.isPending} data-testid="agent-project" data-on={on ? '1' : '0'}
              className={`rounded-full border px-2 py-0.5 text-meta ${on ? 'border-accent text-accent' : 'border-hair text-tertiary'}`} onClick={() => toggle(p.id)}>
              {on ? '✓ ' : ''}{p.name}{isDefault ? ' · 默认' : ''}
            </button>
          );
        })}
      </div>
      {save.error ? <p className="text-meta text-rust">{errorText(save.error)}</p> : null}
    </div>
  );
}

function Triggers({ projectId, name }: { projectId: string; name: string }) {
  const key = ['bindings', projectId, name];
  const list = useQuery({ queryKey: key, queryFn: () => connectorApi.bindings(projectId, name), refetchInterval: 15_000 });
  const [adding, setAdding] = useState(false);
  const items = list.data?.bindings ?? [];
  return (
    <div data-testid="bot-triggers">
      <div className="flex items-center gap-2">
        <p className="text-meta text-secondary">触发 <span className="text-tertiary">· 到点叫醒它</span></p>
        {!adding ? <button className={`${SMALL} ml-auto`} data-testid="trigger-new" onClick={() => setAdding(true)}>添加定时</button> : null}
      </div>
      {adding ? <TimerForm projectId={projectId} name={name} onDone={() => setAdding(false)} /> : null}
      <ul className="mt-1 flex flex-col gap-1">
        {items.map((b) => <TriggerRow key={b.id} b={b} listKey={key} />)}
      </ul>
      {!items.length && !adding ? <p className="text-meta text-tertiary" data-testid="trigger-empty">还没有触发。</p> : null}
    </div>
  );
}

function TimerForm({ projectId, name, onDone }: { projectId: string; name: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('定时巡检');
  const [every, setEvery] = useState(15);
  const [prompt, setPrompt] = useState('');
  const [target, setTarget] = useState<'main' | 'new'>('main');
  const create = useMutation({
    mutationFn: () => connectorApi.create(projectId, name, {
      connector: 'timer', kind: 'tick', name: title, target, projectId: null, params: { everyMin: every, prompt },
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['bindings', projectId, name] }); onDone(); }
  });
  return (
    <form className="mt-1 flex flex-col gap-2 rounded-md border border-hair p-2" data-testid="timer-form" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input className={INPUT} aria-label="名称" data-testid="timer-name" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} />
        <label className="flex items-center gap-1 text-meta text-secondary whitespace-nowrap">每
          <input className={`${INPUT} w-20`} type="number" min={5} max={10080} data-testid="timer-every" value={every} onChange={(e) => setEvery(Number(e.target.value))} />分钟</label>
      </div>
      <textarea className={INPUT} rows={3} maxLength={4000} data-testid="timer-prompt" placeholder="到点时对它说什么，例如：看看有没有新任务要拆" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2 text-meta text-secondary">
        <label className="flex items-center gap-1"><input type="radio" checked={target === 'main'} onChange={() => setTarget('main')} />投到它的主会话</label>
        <label className="flex items-center gap-1"><input type="radio" checked={target === 'new'} onChange={() => setTarget('new')} />每次新开会话</label>
      </div>
      <p className="text-meta text-tertiary">最短 5 分钟。上一次没结束就跳过；它正忙就等它；连续失败 5 次自动暂停。</p>
      <div className="flex gap-2">
        <button className={SMALL} type="submit" data-testid="timer-save" disabled={create.isPending || every < 5 || !prompt.trim()}>保存</button>
        <button className={SMALL} type="button" onClick={onDone}>取消</button>
      </div>
      {create.error ? <p className="text-meta text-rust">{errorText(create.error)}</p> : null}
    </form>
  );
}

function TriggerRow({ b, listKey }: { b: BindingDto; listKey: unknown[] }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: listKey });
  const toggle = useMutation({ mutationFn: () => connectorApi.update(b.id, { enabled: !b.enabled }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => connectorApi.remove(b.id), onSuccess: refresh });
  const runs = useQuery({ queryKey: ['runs', b.id], queryFn: () => connectorApi.runs(b.id), enabled: open, refetchInterval: open ? 15_000 : false });
  return (
    <li className="rounded-md border border-hair p-2" data-testid="trigger-item" data-id={b.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body text-primary">⏰ {b.name}</span>
        <span className="text-meta text-tertiary">{b.summary} · {b.target === 'main' ? '主会话' : '新会话'}</span>
        <span className={`text-meta ${b.pausedReason ? 'text-rust' : b.enabled ? 'text-accent' : 'text-tertiary'}`} data-testid="trigger-state">
          {b.pausedReason ? '已暂停' : b.enabled ? `下次 ${time(b.nextRunAt)}` : '已停用'}
        </span>
        <div className="ml-auto flex gap-1">
          <button className={SMALL} data-testid="trigger-runs" onClick={() => setOpen(!open)}>{open ? '收起' : '记录'}</button>
          <button className={SMALL} data-testid="trigger-toggle" disabled={toggle.isPending} onClick={() => toggle.mutate()}>{b.enabled ? '暂停' : '恢复'}</button>
          <button className={DANGER} data-testid="trigger-delete" disabled={remove.isPending} onClick={() => remove.mutate()}>删除</button>
        </div>
      </div>
      {b.pausedReason ? <p className="text-meta text-rust">{b.pausedReason}</p> : null}
      {b.lastRun ? <p className="text-meta text-tertiary">上次 {time(b.lastRun.createdAt)} · {STATE[b.lastRun.state]}{b.lastRun.reason ? ` · ${b.lastRun.reason}` : ''}</p> : null}
      {open ? (
        <ul className="mt-1 flex flex-col gap-0.5" data-testid="trigger-run-list">
          {(runs.data?.runs ?? []).map((r) => (
            <li key={r.id} className="flex flex-wrap gap-2 text-meta text-secondary" data-testid="trigger-run" data-state={r.state}>
              <span>{time(r.plannedAt ?? r.createdAt)}</span><span>{STATE[r.state]}{r.catchup ? ' · 补跑' : ''}</span>
              {r.reason ? <span className="text-tertiary">{r.reason}</span> : null}
              {r.sessionId ? <a className="text-accent" href={formatRoute({ page: 'project', projectId: b.agentProjectId, view: 'focus', sessionId: r.sessionId })}>会话</a> : null}
            </li>
          ))}
          {runs.data && !runs.data.runs.length ? <li className="text-meta text-tertiary">还没有运行过</li> : null}
        </ul>
      ) : null}
    </li>
  );
}
