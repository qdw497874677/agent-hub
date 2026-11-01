import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, botApi, type BotColorDto, type BotDto, type MessagingRoleDto } from './api.ts';
import { AccountMenu, useAccount } from './auth.tsx';
import { formatRoute } from './route.ts';
import { INPUT, SMALL, DANGER, errorText, Empty } from './admin/shared.tsx';

/**
 * Bot 页（#/bots[/<项目>]）：持久智能体在界面上就叫 bot。
 * 每个 bot 一行：彩色首字头像、显示名、@id、运行时 · 模型、在哪些群。
 * 新建 / 编辑在同一张表单里；@id 建好不改；职责说明 ≤ 4000 字，作为它的系统提示。
 * 删除会先列出它所在的群，确认后从这些群里移出。
 */
export const BOT_COLORS: Record<BotColorDto, string> = {
  amber: '#d9a05b', sage: '#8fae8b', sky: '#7ea6c9', rose: '#c98a8a', olive: '#a9a86a', slate: '#8c96a0'
};
const COLOR_KEYS = Object.keys(BOT_COLORS) as BotColorDto[];
const RUNTIMES = [
  { id: 'pi', label: 'Pi' }, { id: 'opencode', label: 'OpenCode' }, { id: 'grok', label: 'Grok' }, { id: 'hermes', label: 'Hermes' }
];
const DESCRIPTION_MAX = 4000;
export const BOTS_KEY = ['bots'] as const;

export const botLabel = (b: Pick<MessagingRoleDto, 'name' | 'displayName'>) => b.displayName?.trim() || b.name;

export function BotAvatar({ bot, size = 32 }: { bot: Pick<MessagingRoleDto, 'name' | 'displayName' | 'color'>; size?: number }) {
  const bg = BOT_COLORS[bot.color ?? 'amber'] ?? BOT_COLORS.amber;
  return (
    <span
      aria-hidden
      data-testid="bot-avatar"
      className="inline-flex shrink-0 items-center justify-center rounded-full font-medium text-canvas"
      style={{ width: size, height: size, background: bg, fontSize: size * 0.45 }}
    >
      {[...botLabel(bot)][0]?.toUpperCase()}
    </span>
  );
}

/** 消息区顶部的「群聊 | Bot」切换。 */
export function HubTabs({ active, projectId }: { active: 'messages' | 'bots'; projectId: string | null }) {
  const tab = (on: boolean) => `rounded-sm px-2.5 py-1 text-meta ${on ? 'bg-card text-primary' : 'text-tertiary hover:text-secondary'}`;
  return (
    <nav className="flex gap-1" aria-label="消息区">
      <a data-testid="tab-messages" className={tab(active === 'messages')} aria-current={active === 'messages' ? 'page' : undefined} href={formatRoute({ page: 'messages', projectId, groupId: null })}>群聊</a>
      <a data-testid="tab-bots" className={tab(active === 'bots')} aria-current={active === 'bots' ? 'page' : undefined} href={formatRoute({ page: 'bots', projectId })}>Bot</a>
    </nav>
  );
}

function BotForm({ projectId, bot, onDone }: { projectId: string; bot: BotDto | null; onDone: () => void }) {
  const [name, setName] = useState(bot?.name ?? '');
  const [displayName, setDisplayName] = useState(bot?.displayName ?? '');
  const [color, setColor] = useState<BotColorDto>(bot?.color ?? 'amber');
  const [agentId, setAgentId] = useState(bot?.agentId ?? 'pi');
  const [model, setModel] = useState(bot?.model ?? '');
  const [description, setDescription] = useState(bot?.description ?? '');
  const [reuse, setReuse] = useState<MessagingRoleDto['reuse']>(bot?.reuse ?? 'sticky');
  const [more, setMore] = useState(false);
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () => {
      const input = { displayName: displayName.trim(), color, agentId, model: model.trim(), description, reuse };
      return bot ? botApi.update(projectId, bot.name, input) : botApi.create(projectId, { name: name.trim(), ...input });
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: BOTS_KEY }); void client.invalidateQueries({ queryKey: ['groups'] }); onDone(); }
  });
  const preview = { name: name || '?', displayName, color };
  const known = RUNTIMES.some((r) => r.id === agentId);
  return (
    <form data-testid="bot-form" className="flex flex-col gap-3 rounded-md border border-strong bg-panel p-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="flex items-center gap-3">
        <BotAvatar bot={preview} size={40} />
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="颜色">
          {COLOR_KEYS.map((c) => (
            <button
              key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} data-testid="bot-color" data-color={c}
              onClick={() => setColor(c)}
              className={`h-6 w-6 rounded-full border-2 ${color === c ? 'border-primary' : 'border-transparent'}`}
              style={{ background: BOT_COLORS[c] }}
            />
          ))}
        </div>
      </div>
      <label className="flex flex-col gap-1 text-meta text-secondary">
        显示名
        <input data-testid="bot-display-name" className={INPUT} maxLength={40} placeholder="比如：代码审查" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-meta text-secondary">
        @id {bot ? <span className="text-tertiary">（建好后不能改）</span> : <span className="text-tertiary">（小写字母、数字、- _，群里用 @它 叫它）</span>}
        <input data-testid="bot-name" className={INPUT} maxLength={40} placeholder="reviewer" value={name} disabled={!!bot} onChange={(e) => setName(e.target.value.toLowerCase())} />
      </label>
      <fieldset className="flex flex-col gap-1 text-meta text-secondary">
        <legend className="mb-1">运行时</legend>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="运行时">
          {RUNTIMES.map((r) => (
            <button key={r.id} type="button" role="radio" aria-checked={agentId === r.id} data-testid="bot-runtime" data-runtime={r.id}
              onClick={() => setAgentId(r.id)}
              className={`rounded-sm border px-2.5 py-1 ${agentId === r.id ? 'border-accent bg-accent/15 text-primary' : 'border-hair text-secondary'}`}>{r.label}</button>
          ))}
          {!known ? <span className="rounded-sm border border-accent bg-accent/15 px-2.5 py-1 text-primary">{agentId}</span> : null}
        </div>
      </fieldset>
      <label className="flex flex-col gap-1 text-meta text-secondary">
        模型 <span className="text-tertiary">（留空用运行时默认；当主持人必须写明）</span>
        <input data-testid="bot-model" className={INPUT} maxLength={200} placeholder="比如：deepseek-v3" value={model} onChange={(e) => setModel(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-meta text-secondary">
        <span className="flex">职责说明<span className="ml-auto text-tertiary" data-testid="bot-description-count">{description.length} / {DESCRIPTION_MAX}</span></span>
        <textarea data-testid="bot-description" className={`${INPUT} min-h-28`} maxLength={DESCRIPTION_MAX} placeholder="它负责什么、怎么说话。会作为它的系统提示。" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <button type="button" className="self-start text-meta text-tertiary hover:text-secondary" data-testid="bot-more" aria-expanded={more} onClick={() => setMore((m) => !m)}>
        {more ? '▾' : '▸'} 高级 · 会话复用：{reuse === 'sticky' ? '一直用同一个会话' : reuse === 'per-trace' ? '每条对话链一个' : '每次新开'}
      </button>
      {more ? (
        <select aria-label="会话复用" data-testid="bot-reuse" className={INPUT} value={reuse} onChange={(e) => setReuse(e.target.value as MessagingRoleDto['reuse'])}>
          <option value="sticky">一直用同一个会话（推荐）</option>
          <option value="per-trace">每条对话链一个会话</option>
          <option value="always-new">每次新开会话</option>
        </select>
      ) : null}
      <div className="flex items-center gap-2">
        <button type="submit" data-testid="bot-save" className={SMALL} disabled={save.isPending || (!bot && !name.trim())}>{bot ? '保存' : '新建 bot'}</button>
        <button type="button" className={SMALL} onClick={onDone}>取消</button>
        {save.error ? <p data-testid="bot-error" className="text-meta text-rust">{errorText(save.error)}</p> : null}
      </div>
    </form>
  );
}

function DeleteConfirm({ projectId, bot, onDone }: { projectId: string; bot: BotDto; onDone: () => void }) {
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () => botApi.remove(projectId, bot.name),
    onSuccess: () => { void client.invalidateQueries({ queryKey: BOTS_KEY }); void client.invalidateQueries({ queryKey: ['groups'] }); onDone(); }
  });
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/30 md:items-center md:justify-center" onClick={onDone}>
      <div data-testid="bot-delete-dialog" role="dialog" aria-label="删除 bot" className="w-full rounded-t-md border border-strong bg-panel p-4 md:w-[420px] md:rounded-md" onClick={(e) => e.stopPropagation()}>
        <p className="text-body text-primary">删除 bot「{botLabel(bot)}」（@{bot.name}）？</p>
        {bot.groups.length ? (
          <>
            <p className="mt-2 text-meta text-secondary">它会从这些群里移出：</p>
            <ul data-testid="bot-delete-groups" className="mt-1 list-disc pl-5 text-meta text-secondary">
              {bot.groups.map((g) => <li key={g.id}>{g.name}{g.host ? '（主持人，删除后这个群没有主持人）' : ''}</li>)}
            </ul>
          </>
        ) : <p className="mt-2 text-meta text-tertiary">它不在任何群里。</p>}
        <p className="mt-2 text-meta text-tertiary">已有的会话和聊天记录会保留。</p>
        <div className="mt-3 flex gap-2">
          <button className={DANGER} data-testid="bot-delete-confirm" disabled={remove.isPending} onClick={() => remove.mutate()}>删除</button>
          <button className={SMALL} onClick={onDone}>取消</button>
          {remove.error ? <p className="text-meta text-rust">{errorText(remove.error)}</p> : null}
        </div>
      </div>
    </div>
  );
}

export function BotsPage({ projectId }: { projectId: string | null }) {
  const account = useAccount();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, enabled: !!account });
  const pid = projectId ?? projects.data?.[0]?.id ?? null;
  const bots = useQuery({ queryKey: [...BOTS_KEY, pid], queryFn: () => botApi.list(pid!), enabled: !!pid });
  const [editing, setEditing] = useState<'new' | string | null>(() => (window.location.hash.endsWith('/new') ? 'new' : null));
  const [deleting, setDeleting] = useState<BotDto | null>(null);
  if (!account) return null;
  const list = bots.data?.agents ?? [];
  const runtime = (id: string) => RUNTIMES.find((r) => r.id === id)?.label ?? id;
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-hair px-3 py-2">
        <div className="min-w-0">
          <a className="text-meta text-tertiary hover:text-accent" href={formatRoute({ page: 'home' })}>← agent-hub</a>
          <h1 className="text-head text-primary">Bot</h1>
        </div>
        <HubTabs active="bots" projectId={pid} />
        <select aria-label="项目" data-testid="bots-project" className={`${INPUT} max-w-[30%]`} value={pid ?? ''} onChange={(e) => { window.location.hash = formatRoute({ page: 'bots', projectId: e.target.value }); }}>
          {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <AccountMenu />
      </header>
      <main className="mx-auto flex w-full max-w-3xl min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <div className="flex items-center">
          <p className="text-meta text-tertiary">bot 是这个项目里常驻的智能体：建好后可以拉进任意群，@它 就能叫它。</p>
          {pid && editing !== 'new' ? <button data-testid="bot-new" className={`${SMALL} ml-auto shrink-0`} onClick={() => setEditing('new')}>新建 bot</button> : null}
        </div>
        {editing === 'new' && pid ? (
          <BotForm projectId={pid} bot={null} onDone={() => {
            setEditing(null);
            // 从「新建 bot」链接进来的（#/bots/<项目>/new），关掉表单后去掉 /new，刷新不再弹出
            if (window.location.hash.endsWith('/new')) window.history.replaceState(null, '', formatRoute({ page: 'bots', projectId: pid }));
          }} />
        ) : null}
        <ul data-testid="bot-list" className="flex flex-col gap-2">
          {list.map((b) => editing === b.name && pid ? (
            <li key={b.name}><BotForm projectId={pid} bot={b} onDone={() => setEditing(null)} /></li>
          ) : (
            <li key={b.name} data-testid="bot-item" data-name={b.name} className="flex items-start gap-3 rounded-md border border-hair bg-card p-3">
              <BotAvatar bot={b} size={36} />
              <div className="min-w-0 flex-1">
                <p className="text-body text-primary">{botLabel(b)} <span className="text-meta text-tertiary">@{b.name}</span></p>
                <p className="text-meta text-secondary">{runtime(b.agentId)} · {b.model || '默认模型'}</p>
                {b.description ? <p className="mt-1 line-clamp-2 text-meta text-tertiary">{b.description}</p> : null}
                <p className="mt-1 text-meta text-tertiary" data-testid="bot-groups">{b.groups.length ? `在 ${b.groups.map((g) => g.name).join('、')}` : '还没进群'}</p>
              </div>
              <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
                <button className={SMALL} data-testid="bot-edit" onClick={() => setEditing(b.name)}>编辑</button>
                <button className={DANGER} data-testid="bot-delete" onClick={() => setDeleting(b)}>删除</button>
              </div>
            </li>
          ))}
        </ul>
        {!list.length && editing !== 'new' ? (
          <div data-testid="bots-empty" className="flex flex-col items-center gap-2 py-10 text-center">
            <Empty text={bots.isLoading ? '加载中…' : pid ? '还没有 bot。新建一个，再把它拉进群。' : '先建一个项目'} />
          </div>
        ) : null}
      </main>
      {deleting && pid ? <DeleteConfirm projectId={pid} bot={deleting} onDone={() => setDeleting(null)} /> : null}
    </div>
  );
}
