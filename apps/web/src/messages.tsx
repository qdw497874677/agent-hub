import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, groupApi, type GroupDto, type GroupInputDto, type GroupPostDto, type MessagingRoleDto } from './api.ts';
import { AccountMenu, useAccount } from './auth.tsx';
import { formatRoute } from './route.ts';
import { MessagesEntry, useGroupUnread, useMarkGroupRead } from './messages-entry.tsx';
import { INPUT, SMALL, DANGER, errorText, Empty } from './admin/shared.tsx';
import { BotAvatar, HubTabs, botLabel } from './bots.tsx';

/**
 * 消息页（#/messages[/<项目>[/<群>]]，ADR 0018 · 群组，界面方案 C）：
 * 左边群列表，中间 IM 对话，右边成员 + 调用链（链到画布的专注对话）。
 * 390px：列表 → 全屏对话 → 成员 / 调用链 / 设置从底部抽屉拉出。
 */
const KEY = ['groups'] as const;
type Drawer = null | 'members' | 'chains' | 'settings';

function authorLabel(post: GroupPostDto): string {
  if (post.author.kind === 'user') return post.author.name;
  if (post.author.kind === 'agent') return post.author.role;
  return '系统';
}

function GroupForm({ projectId, roles, group, onDone }: { projectId: string; roles: MessagingRoleDto[]; group: GroupDto | null; onDone: (g: GroupDto) => void }) {
  const [name, setName] = useState(group?.name ?? '');
  const [members, setMembers] = useState<string[]>(group?.members ?? []);
  const [hostRole, setHostRole] = useState<string>(group?.hostRole ?? '');
  const [strategy, setStrategy] = useState<'host' | 'volunteer'>(group?.speakingStrategy ?? 'host');
  const [rounds, setRounds] = useState(group?.limits.maxRounds ?? 3);
  const [msgs, setMsgs] = useState(group?.limits.maxMessages ?? 10);
  const [advanced, setAdvanced] = useState(false);
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (input: GroupInputDto) => (group ? groupApi.update(group.id, input) : groupApi.create(projectId, input)),
    onSuccess: (g) => { void client.invalidateQueries({ queryKey: KEY }); onDone(g); }
  });
  // 主持人必须是写明了模型的 bot
  const hostable = roles.filter((r) => r.model.trim() && r.name !== '');
  return (
    <form
      data-testid="group-form"
      className="flex flex-col gap-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ name: name.trim(), members, hostRole: hostRole || null, speakingStrategy: strategy, limits: { maxRounds: rounds, maxMessages: msgs } });
      }}
    >
      <input aria-label="群名" data-testid="group-name" className={INPUT} placeholder="群名" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      <fieldset className="flex flex-col gap-1 text-meta text-secondary">
        <legend className="mb-1 text-tertiary">选成员（项目里的 bot）</legend>
        {members.length ? (
          <div className="flex flex-wrap gap-1" data-testid="group-chips">
            {members.map((m) => {
              const r = roles.find((x) => x.name === m);
              return (
                <button key={m} type="button" data-testid="group-chip" className="flex items-center gap-1 rounded-full border border-hair bg-card py-0.5 pl-0.5 pr-2 text-primary" onClick={() => setMembers((xs) => xs.filter((x) => x !== m))} aria-label={`移除 ${m}`}>
                  <BotAvatar bot={r ?? { name: m }} size={18} />{r ? botLabel(r) : m} ×
                </button>
              );
            })}
          </div>
        ) : null}
        {roles.length === 0 ? (
          <span data-testid="group-no-bots" className="flex items-center gap-2 text-tertiary">
            这个项目还没有 bot。
            <a className={SMALL} data-testid="group-go-new-bot" href={`${formatRoute({ page: 'bots', projectId })}/new`}>新建 bot</a>
          </span>
        ) : null}
        <ul className="flex max-h-56 flex-col overflow-y-auto rounded-sm border border-hair">
          {roles.map((r) => (
            <li key={r.name}>
              <label className="flex items-center gap-2 border-b border-hair px-2 py-1.5 last:border-0">
                <input
                  type="checkbox"
                  data-testid="group-member"
                  value={r.name}
                  checked={members.includes(r.name)}
                  onChange={(e) => setMembers((m) => (e.target.checked ? [...m, r.name] : m.filter((x) => x !== r.name)))}
                />
                <BotAvatar bot={r} size={22} />
                <span className="text-primary">{botLabel(r)}</span>
                <span className="text-tertiary">@{r.name}</span>
                <span className="ml-auto truncate text-tertiary">{r.agentId}{r.model ? ` · ${r.model}` : ''}</span>
              </label>
            </li>
          ))}
        </ul>
        {roles.length ? <a className="self-start text-tertiary hover:text-accent" href={`${formatRoute({ page: 'bots', projectId })}/new`}>＋ 新建 bot</a> : null}
      </fieldset>
      <button type="button" data-testid="group-advanced" aria-expanded={advanced} className="self-start text-meta text-tertiary hover:text-secondary" onClick={() => setAdvanced((v) => !v)}>
        {advanced ? '▾' : '▸'} 高级设置 · {hostRole ? `主持人 @${hostRole}` : '无主持人'} · {strategy === 'host' ? '主持人分派' : '成员竞价'} · {rounds} 轮 / {msgs} 条
      </button>
      {advanced ? (
        <div data-testid="group-advanced-panel" className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-meta text-secondary">
        主持人
        <select aria-label="主持人" data-testid="group-host" className={`${INPUT} flex-1`} value={hostRole} onChange={(e) => setHostRole(e.target.value)}>
          <option value="">不设</option>
          {hostable.map((r) => <option key={r.name} value={r.name}>{botLabel(r)}（{r.model}）</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-meta text-secondary">
        谁来接话
        <select aria-label="发言方式" className={`${INPUT} flex-1`} value={strategy} onChange={(e) => setStrategy(e.target.value as 'host' | 'volunteer')}>
          <option value="host">主持人分派</option>
          <option value="volunteer">成员竞价</option>
        </select>
      </label>
      <div className="flex gap-2 text-meta text-secondary">
        <label className="flex items-center gap-1">轮数<input aria-label="轮数" data-testid="group-rounds" type="number" min={1} max={5} className={`${INPUT} w-16`} value={rounds} onChange={(e) => setRounds(Number(e.target.value))} /></label>
        <label className="flex items-center gap-1">条数<input aria-label="条数" type="number" min={1} max={20} className={`${INPUT} w-16`} value={msgs} onChange={(e) => setMsgs(Number(e.target.value))} /></label>
      </div>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <button type="submit" data-testid="group-save" className={SMALL} disabled={save.isPending || !name.trim() || members.length === 0}>{group ? '保存' : '建群'}</button>
        {save.error ? <p data-testid="group-error" className="text-meta text-rust">{errorText(save.error)}</p> : null}
      </div>
    </form>
  );
}

function MembersPanel({ groupId, projectId }: { groupId: string; projectId: string }) {
  const view = useQuery({ queryKey: [...KEY, 'view', groupId], queryFn: () => groupApi.view(groupId), refetchInterval: 4000 });
  const roles = useQuery({ queryKey: [...KEY, 'roles', projectId], queryFn: () => groupApi.roles(projectId) });
  const client = useQueryClient();
  const [adding, setAdding] = useState<string[] | null>(null);
  const done = () => { void client.invalidateQueries({ queryKey: KEY }); void client.invalidateQueries({ queryKey: ['bots'] }); };
  const add = useMutation({ mutationFn: (names: string[]) => groupApi.addMembers(groupId, names), onSuccess: () => { setAdding(null); done(); } });
  const remove = useMutation({ mutationFn: (name: string) => groupApi.removeMember(groupId, name), onSuccess: done });
  const g = view.data?.group;
  if (!g) return <Empty text="加载中…" />;
  const canManage = view.data?.canManage ?? false;
  const all = roles.data?.roles ?? [];
  const outside = all.filter((r) => !g.members.includes(r.name));
  const held = (r: string) => g.held.includes('*') || g.held.includes(r);
  return (
    <div className="p-2 text-meta">
      <ul data-testid="group-members">
        {g.members.map((m) => {
          const s = view.data?.sessions.find((x) => x.role === m);
          const r = all.find((x) => x.name === m);
          return (
            <li key={m} data-testid="group-member-row" data-role={m} className="flex items-center gap-2 border-b border-hair px-1 py-1.5 last:border-0">
              <BotAvatar bot={r ?? { name: m }} size={22} />
              <span className="min-w-0 truncate text-primary">{r ? botLabel(r) : m}</span>
              {g.hostRole === m ? <span className="text-tertiary">主持人</span> : null}
              {held(m) ? <span data-testid="member-held" className="text-rust">已暂停</span> : null}
              {s ? (
                <a className="ml-auto text-accent" href={formatRoute({ page: 'project', projectId, view: 'focus', sessionId: s.sessionId })}>{s.status === 'busy' ? '在说…' : '会话'} →</a>
              ) : <span className="ml-auto text-tertiary">还没开口</span>}
              {canManage && g.hostRole !== m && g.members.length > 1 ? (
                <button className="text-tertiary hover:text-rust" data-testid="member-remove" data-role={m} aria-label={`把 ${m} 移出群`} disabled={remove.isPending} onClick={() => { if (window.confirm(`把 @${m} 移出「${g.name}」？`)) remove.mutate(m); }}>移出</button>
              ) : null}
            </li>
          );
        })}
        {g.hostRole && !g.members.includes(g.hostRole) ? (
          <li className="px-1 py-1.5 text-tertiary">主持人：{g.hostRole}</li>
        ) : null}
      </ul>
      {remove.error ? <p className="px-1 text-rust">{errorText(remove.error)}</p> : null}
      {canManage ? (
        adding ? (
          <div data-testid="member-add-panel" className="mt-2 flex flex-col gap-1 rounded-sm border border-hair p-2">
            {outside.length ? outside.map((r) => (
              <label key={r.name} className="flex items-center gap-2">
                <input type="checkbox" data-testid="member-add-option" value={r.name} checked={adding.includes(r.name)} onChange={(e) => setAdding((xs) => (e.target.checked ? [...(xs ?? []), r.name] : (xs ?? []).filter((x) => x !== r.name)))} />
                <BotAvatar bot={r} size={18} /><span className="text-primary">{botLabel(r)}</span><span className="text-tertiary">@{r.name}</span>
              </label>
            )) : <span className="text-tertiary">项目里的 bot 都在群里了。</span>}
            <div className="mt-1 flex gap-2">
              <button className={SMALL} data-testid="member-add-confirm" disabled={!adding.length || add.isPending} onClick={() => add.mutate(adding)}>加进群</button>
              <button className={SMALL} onClick={() => setAdding(null)}>取消</button>
              <a className="ml-auto self-center text-tertiary hover:text-accent" href={`${formatRoute({ page: 'bots', projectId })}/new`}>新建 bot</a>
            </div>
            {add.error ? <p className="text-rust">{errorText(add.error)}</p> : null}
          </div>
        ) : (
          <button className={`${SMALL} mt-2`} data-testid="member-add" onClick={() => setAdding([])}>＋ 添加成员</button>
        )
      ) : null}
    </div>
  );
}

const PURPOSE: Record<string, string> = { host: '主持', member: '发言', bid: '竞价' };
function ChainsPanel({ groupId, projectId }: { groupId: string; projectId: string }) {
  const chains = useQuery({ queryKey: [...KEY, 'chains', groupId], queryFn: () => groupApi.chains(groupId), refetchInterval: 4000 });
  const list = chains.data?.chains ?? [];
  if (!list.length) return <Empty text={chains.isLoading ? '加载中…' : '还没有调用链'} />;
  return (
    <ol data-testid="group-chains" className="flex flex-col gap-2 p-2 text-meta">
      {list.map(({ thread, deliveries }) => (
        <li key={thread.id} className="rounded-sm border border-hair p-2">
          <p className="text-tertiary">对话 · {thread.status} · 第 {thread.round} 轮 · {thread.messages} 条</p>
          <ul className="mt-1">
            {deliveries.map((d) => (
              <li key={d.id} data-testid="chain-delivery" className="flex flex-wrap items-center gap-1.5 py-0.5">
                <span className="text-secondary">R{d.round}</span>
                <span className="text-primary">{d.role}</span>
                <span className="text-tertiary">{PURPOSE[d.purpose] ?? d.purpose} · {d.status}{d.score !== null ? ` · ${d.score}` : ''}</span>
                {d.sessionId ? <a className="ml-auto text-accent" href={formatRoute({ page: 'project', projectId, view: 'focus', sessionId: d.sessionId })}>画布 →</a> : null}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function Chat({ group, onDrawer }: { group: GroupDto; onDrawer: (d: Drawer) => void }) {
  const client = useQueryClient();
  const posts = useQuery({ queryKey: [...KEY, 'posts', group.id], queryFn: () => groupApi.posts(group.id), refetchInterval: 2500 });
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: (body: string) => groupApi.post(group.id, body),
    onSuccess: () => { setText(''); void client.invalidateQueries({ queryKey: KEY }); }
  });
  const stop = useMutation({ mutationFn: () => groupApi.stop(group.id), onSuccess: () => void client.invalidateQueries({ queryKey: KEY }) });
  const roles = useQuery({ queryKey: [...KEY, 'roles', group.projectId], queryFn: () => groupApi.roles(group.projectId) });
  const view = useQuery({ queryKey: [...KEY, 'view', group.id], queryFn: () => groupApi.view(group.id), refetchInterval: 4000 });
  const canManage = view.data?.canManage === true;
  // 只能 @ 群成员：@ 到群外的 bot 只给提示，有 group.manage 的人多一个「加入群组」；加完不重放，由人再发
  const add = useMutation({ mutationFn: (v: { postId: string; role: string }) => groupApi.addMember(group.id, v.role), onSuccess: () => void client.invalidateQueries({ queryKey: KEY }) });
  const roleNames = (roles.data?.roles ?? []).map((r) => r.name);
  const outsidersOf = (body: string): string[] =>
    [...new Set([...body.matchAll(/(^|[^\w@.])@([a-z0-9][a-z0-9_-]{0,39})/gi)].map((m) => m[2]!))].filter((n) => roleNames.includes(n) && !group.members.includes(n));
  const bottom = useRef<HTMLDivElement>(null);
  const count = posts.data?.posts.length ?? 0;
  useMarkGroupRead(group.id, posts.data ? (posts.data.posts.at(-1)?.seq ?? 0) : null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [count]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-hair px-3 py-2">
        <a className="text-meta text-tertiary md:hidden" href={formatRoute({ page: 'messages', projectId: group.projectId, groupId: null })}>←</a>
        <h2 className="min-w-0 truncate text-body text-primary" data-testid="chat-title">{group.name}</h2>
        {group.needsUser ? <span data-testid="needs-you" className="rounded-sm border border-rust px-1.5 text-meta text-rust">需要你</span> : null}
        <div className="ml-auto flex gap-1">
          <button className={`${SMALL} lg:hidden`} data-testid="open-members" onClick={() => onDrawer('members')}>成员</button>
          <button className={`${SMALL} lg:hidden`} data-testid="open-chains" onClick={() => onDrawer('chains')}>调用链</button>
          <button className={SMALL} data-testid="open-settings" onClick={() => onDrawer('settings')}>设置</button>
          <button className={DANGER} data-testid="group-stop" disabled={stop.isPending} onClick={() => stop.mutate()}>停止</button>
        </div>
      </div>
      <ol data-testid="group-posts" className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {(posts.data?.posts ?? []).map((p) => (
          <li key={p.id} data-testid="group-post" data-author={p.author.kind} className={`my-1.5 flex flex-col ${p.author.kind === 'user' ? 'items-end' : 'items-start'}`}>
            {p.author.kind === 'system' ? (
              <p data-testid="system-line" className="w-full text-center text-meta text-tertiary">{p.body}</p>
            ) : (
              <>
                <span className="text-meta text-tertiary">{authorLabel(p)}</span>
                <p className={`max-w-[85%] whitespace-pre-wrap break-words rounded-md px-3 py-1.5 text-body ${p.author.kind === 'user' ? 'bg-accent/15 text-primary' : 'bg-card text-primary'}`}>{p.body}</p>
                {p.author.kind === 'user'
                  ? outsidersOf(p.body).map((role) => (
                      <span key={role} className="mt-1 flex items-center gap-2 text-meta text-tertiary" data-testid="group-outsider" data-role={role}>
                        @{role} 不在群里，只能 @ 群成员
                        {canManage ? (
                          <button className={SMALL} data-testid="group-add-member" data-role={role} disabled={add.isPending} onClick={() => add.mutate({ postId: p.id, role })}>
                            加入群组
                          </button>
                        ) : null}
                      </span>
                    ))
                  : null}
                {add.isError && add.variables && add.variables.postId === p.id ? <span className="text-meta text-rust" data-testid="group-add-member-error">{(add.error as Error).message}</span> : null}
              </>
            )}
          </li>
        ))}
        <div ref={bottom} />
      </ol>
      <form
        className="flex gap-2 border-t border-hair p-2"
        onSubmit={(e) => { e.preventDefault(); if (text.trim()) send.mutate(text.trim()); }}
      >
        <textarea
          aria-label="发消息"
          data-testid="group-input"
          className={`${INPUT} min-h-10 flex-1`}
          placeholder={`发到群里；@${group.members[0] ?? '成员'} 直达，「停止 @成员」暂停某人`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (text.trim()) send.mutate(text.trim()); } }}
        />
        <button type="submit" data-testid="group-send" className={SMALL} disabled={send.isPending || !text.trim()}>发送</button>
      </form>
      {send.error ? <p className="px-3 pb-2 text-meta text-rust">{errorText(send.error)}</p> : null}
    </div>
  );
}

export function MessagesPage({ projectId, groupId }: { projectId: string | null; groupId: string | null }) {
  const account = useAccount();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, enabled: !!account });
  const pid = projectId ?? projects.data?.[0]?.id ?? null;
  const groups = useQuery({ queryKey: [...KEY, 'list', pid], queryFn: () => groupApi.list(pid!), enabled: !!pid, refetchInterval: 5000 });
  const roles = useQuery({ queryKey: [...KEY, 'roles', pid], queryFn: () => groupApi.roles(pid!), enabled: !!pid });
  const [drawer, setDrawer] = useState<Drawer>(null);
  const unread = useGroupUnread();
  const unreadOf = (id: string): number => unread.data?.groups.find((u) => u.groupId === id)?.count ?? 0;
  const [creating, setCreating] = useState(false);
  if (!account) return null;
  const list = groups.data?.groups ?? [];
  const current = list.find((g) => g.id === groupId) ?? null;
  const go = (g: string | null) => { window.location.hash = formatRoute({ page: 'messages', projectId: pid, groupId: g }); };
  const roleList = roles.data?.roles ?? [];
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-hair px-3 py-2">
        <div className="min-w-0">
          <a className="text-meta text-tertiary hover:text-accent" href={formatRoute({ page: 'home' })}>← agent-hub</a>
          <h1 className="text-head text-primary">消息</h1>
        </div>
        <HubTabs active="messages" projectId={pid} />
        <select aria-label="项目" data-testid="messages-project" className={`${INPUT} max-w-[40%]`} value={pid ?? ''} onChange={(e) => { window.location.hash = formatRoute({ page: 'messages', projectId: e.target.value, groupId: null }); }}>
          {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="flex shrink-0 items-center gap-2">
          <MessagesEntry />
          <AccountMenu />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className={`${current ? 'hidden md:flex' : 'flex'} w-full flex-col border-r border-hair md:w-64`}>
          <ul data-testid="group-list" className="min-h-0 flex-1 overflow-y-auto">
            {list.map((g) => (
              <li key={g.id}>
                <a
                  data-testid="group-item"
                  href={formatRoute({ page: 'messages', projectId: pid, groupId: g.id })}
                  aria-current={g.id === current?.id ? 'page' : undefined}
                  className={`flex items-center gap-2 border-b border-hair px-3 py-2.5 text-body ${g.id === current?.id ? 'bg-card text-primary' : 'text-secondary hover:bg-card'}`}
                >
                  <span className="min-w-0 flex-1 truncate">{g.name}</span>
                  {unreadOf(g.id) && g.id !== current?.id ? (
                    <span data-testid="group-unread" aria-label={`${unreadOf(g.id)} 条未读`} className="min-w-[18px] rounded-full bg-rust px-1.5 text-center text-meta leading-[18px] text-canvas">
                      {unreadOf(g.id)}
                    </span>
                  ) : null}
                  {g.needsUser ? <span className="rounded-sm border border-rust px-1.5 text-meta text-rust">需要你</span> : null}
                  <span className="text-meta text-tertiary">{g.members.length} 人</span>
                </a>
              </li>
            ))}
            {!list.length ? (
              groups.isLoading || !pid || roles.isLoading || roleList.length ? <Empty text={groups.isLoading ? '加载中…' : pid ? '还没有群' : '先建一个项目'} /> : (
                <li data-testid="messages-empty" className="flex flex-col items-start gap-2 px-3 py-6 text-meta text-tertiary">
                  <span className="text-body text-secondary">还没有 bot，也还没有群</span>
                  <span>先建一个 bot（常驻的智能体），再把它拉进群里聊。</span>
                  <a className={SMALL} data-testid="empty-new-bot" href={`${formatRoute({ page: 'bots', projectId: pid })}/new`}>新建 bot</a>
                </li>
              )
            ) : null}
          </ul>
          {pid ? (
            <div className="border-t border-hair">
              {creating ? (
                <GroupForm projectId={pid} roles={roleList} group={null} onDone={(g) => { setCreating(false); go(g.id); }} />
              ) : (
                <button data-testid="group-new" className={`${SMALL} m-2`} onClick={() => setCreating(true)}>新建群</button>
              )}
            </div>
          ) : null}
        </aside>
        {current && pid ? (
          <>
            <section className="flex min-w-0 flex-1 flex-col">
              <Chat group={current} onDrawer={setDrawer} />
            </section>
            <aside className="hidden w-72 flex-col overflow-y-auto border-l border-hair lg:flex">
              <h3 className="px-3 pt-2 text-meta text-tertiary">成员</h3>
              <MembersPanel groupId={current.id} projectId={pid} />
              <h3 className="px-3 pt-2 text-meta text-tertiary">调用链</h3>
              <ChainsPanel groupId={current.id} projectId={pid} />
            </aside>
          </>
        ) : (
          <div className="hidden flex-1 items-center justify-center md:flex"><Empty text="选一个群" /></div>
        )}
      </div>
      {drawer && current && pid ? (
        <div className="fixed inset-0 z-40 flex items-end bg-black/30 md:items-center md:justify-center" onClick={() => setDrawer(null)}>
          <div data-testid="group-drawer" className="max-h-[75vh] w-full overflow-y-auto rounded-t-md border border-strong bg-panel md:w-[480px] md:rounded-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center border-b border-hair px-3 py-2">
              <span className="text-body text-primary">{drawer === 'members' ? '成员' : drawer === 'chains' ? '调用链' : '群设置'}</span>
              <button className={`${SMALL} ml-auto`} onClick={() => setDrawer(null)}>关闭</button>
            </div>
            {drawer === 'members' ? <MembersPanel groupId={current.id} projectId={pid} /> : null}
            {drawer === 'chains' ? <ChainsPanel groupId={current.id} projectId={pid} /> : null}
            {drawer === 'settings' ? (
              <GroupForm key={current.updatedAt} projectId={pid} roles={roleList} group={current} onDone={() => setDrawer(null)} />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
