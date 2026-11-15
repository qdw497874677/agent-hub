import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, groupApi, type GroupDto, type GroupInputDto, type GroupPostDto, type MessagingRoleDto } from '../../shell/api.ts';
import { AccountMenu, useAccount } from '../../shell/auth.tsx';
import { formatRoute } from '../../shell/route.ts';
import { MessagesEntry, useGroupUnread, useMarkGroupRead } from '../../atoms/messages-entry.tsx';
import { INPUT, SMALL, DANGER, errorText, Empty } from '../../shell/admin/shared.tsx';
import { NameDot } from '../../atoms/author.tsx';
import { BUBBLE_MD, LogMarkdown } from '../../atoms/log-markdown.tsx';
import { useLiveStream } from '../../atoms/live.ts';
import { liveDrafts, typingLine, typingRoles } from '../../atoms/group-live.ts';
import { useReactions } from '../../atoms/use-reactions.ts';
import { ReactionBar } from '../../atoms/group-reactions.tsx';
import { DraftBubble } from '../../atoms/group-draft.tsx';
import { TypingLine } from '../../atoms/group-typing.tsx';
import { insertMention, mentionItems, mentionRange, stepMention, type MentionItem, type MentionMember } from '../../atoms/mention-suggest.ts';
import { useCompact } from '../../shell/device.ts';
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
  if (post.author.kind === 'external') return post.author.name;
  return '系统';
}

/** 消息时间：本地时区的 HH:mm。 */
function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 成员是不是被暂停了：`*` 是全体。 */
const heldOf = (group: GroupDto, name: string): boolean => group.held.includes('*') || group.held.includes(name);

/** 手机聊天头 ⋯ 菜单里的一项。 */
const MENU_ROW = 'w-full rounded-sm px-2 py-1.5 text-left text-meta text-secondary hover:bg-card hover:text-accent';

function GroupForm({ projectId, roles, group, onDone, openAdvanced = false }: { projectId: string; roles: MessagingRoleDto[]; group: GroupDto | null; onDone: (g: GroupDto) => void; openAdvanced?: boolean }) {
  const [name, setName] = useState(group?.name ?? '');
  const [members, setMembers] = useState<string[]>(group?.members ?? []);
  const [hostRole, setHostRole] = useState<string>(group?.hostRole ?? '');
  const [strategy, setStrategy] = useState<'host' | 'volunteer'>(group?.speakingStrategy ?? 'host');
  const [rounds, setRounds] = useState(group?.limits.maxRounds ?? 3);
  const [msgs, setMsgs] = useState(group?.limits.maxMessages ?? 10);
  const [advanced, setAdvanced] = useState(openAdvanced);
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (input: GroupInputDto) => (group ? groupApi.update(group.id, input) : groupApi.create(projectId, input)),
    onSuccess: (g) => { void client.invalidateQueries({ queryKey: KEY }); onDone(g); }
  });
  // 主持人：项目里有名字的 bot 都能当；模型留空就是运行时默认模型
  const hostable = roles.filter((r) => r.name !== '');
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
          {hostable.map((r) => <option key={r.name} value={r.name}>{botLabel(r)}（{r.model || '默认模型'}）</option>)}
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

function Chat({ group, onDrawer }: { group: GroupDto; onDrawer: (d: Drawer, focusHost?: boolean) => void }) {
  const client = useQueryClient();
  const compact = useCompact();
  const posts = useQuery({ queryKey: [...KEY, 'posts', group.id], queryFn: () => groupApi.posts(group.id), refetchInterval: 2500 });
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: (body: string) => groupApi.post(group.id, body),
    onSuccess: () => { setText(''); setCaret(0); void client.invalidateQueries({ queryKey: KEY }); }
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
  // 反应里「我」的名字：和帖子作者名同源（displayName || email，见 groups.ts:584）
  const account = useAccount();
  const meName = account ? account.displayName || account.email : null;
  // 消息页没有 Workspace 那份 live map（路由切过来时它已卸载），所以这里单独挂同一条全局 SSE；
  // 只用来看草稿，草稿不落库，也不额外轮询
  const { live } = useLiveStream();
  const list = posts.data?.posts ?? [];
  const typing = view.data?.typing ?? [];
  // 契约里 running thread 没有 sessionId，没法逐个成员对轮次；群同一时刻只有一条活跃 thread
  const round = view.data?.running[0]?.round ?? 0;
  const drafts = liveDrafts({ typing, blocksOf: (id) => live[id]?.blocks ?? [], round, posts: list });
  const typingText = typingLine(typingRoles(typing, drafts));
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [count, drafts.length]);

  // 表情反应：请求、乐观更新、回滚都在 useReactions 里，这里只接线
  const { reactTo, error: reactError } = useReactions({ groupId: group.id, me: meName, key: KEY });

  // 手机聊天头的「⋯」：点外面就收起
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [menu]);

  // 停止要确认：说清楚影响，取消后把焦点还给输入框，方便接着写
  const input = useRef<HTMLTextAreaElement>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const cancelStop = () => { setConfirmStop(false); input.current?.focus(); };
  useEffect(() => {
    if (!confirmStop) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelStop(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmStop]);

  // @ 补全：只看光标前的最后一段 @xxx
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const labels = new Map((roles.data?.roles ?? []).map((r) => [r.name, botLabel(r)]));
  const mentionables: MentionMember[] = group.members.map((m) => {
    const label = labels.get(m);
    return { name: m, host: group.hostRole === m, held: heldOf(group, m), ...(label ? { label } : {}) };
  });
  const range = mentionRange(text, caret);
  const rangeKey = range ? `${range.start}:${range.end}` : null;
  const candidates = range ? mentionItems(mentionables, range.query) : [];
  const open = candidates.length > 0 && rangeKey !== dismissed;
  const highlighted = Math.min(pick, Math.max(0, candidates.length - 1));
  useEffect(() => { setPick(0); }, [rangeKey]);
  const applyMention = (item: MentionItem) => {
    if (!range) return;
    const next = insertMention(text, range, item.token);
    setText(next.text);
    setDismissed(null);
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };
  const submit = () => { const body = text.trim(); if (body) send.mutate(body); };
  const hostBot = group.hostRole ? roles.data?.roles.find((r) => r.name === group.hostRole) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-hair px-3 py-2">
        <a className="text-meta text-tertiary md:hidden" aria-label="返回群列表" href={formatRoute({ page: 'messages', projectId: group.projectId, groupId: null })}>←</a>
        <h2 className="min-w-0 truncate text-body text-primary" data-testid="chat-title">{group.name}</h2>
        {group.needsUser ? <span data-testid="needs-you" className="shrink-0 rounded-sm border border-rust px-1.5 text-meta text-rust">需要你</span> : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {compact ? (
            <>
              <button className={SMALL} data-testid="open-members" onClick={() => onDrawer('members')}>成员</button>
              <button className={DANGER} data-testid="group-stop" disabled={stop.isPending} onClick={() => setConfirmStop(true)}>停止</button>
              <div className="relative" ref={menuRef}>
                <button className={SMALL} data-testid="group-more" aria-label="更多" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>⋯</button>
                {menu ? (
                  <div data-testid="group-more-menu" className="absolute right-0 top-full z-30 mt-1 flex w-32 flex-col gap-1 rounded-md border border-strong bg-panel p-1 shadow-lg">
                    <button className={MENU_ROW} data-testid="open-chains" onClick={() => { setMenu(false); onDrawer('chains'); }}>调用链</button>
                    <button className={MENU_ROW} data-testid="open-settings" onClick={() => { setMenu(false); onDrawer('settings'); }}>设置</button>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <button className={`${SMALL} lg:hidden`} data-testid="open-members" onClick={() => onDrawer('members')}>成员</button>
              <button className={`${SMALL} lg:hidden`} data-testid="open-chains" onClick={() => onDrawer('chains')}>调用链</button>
              <button className={SMALL} data-testid="open-settings" onClick={() => onDrawer('settings')}>设置</button>
              <button className={DANGER} data-testid="group-stop" disabled={stop.isPending} onClick={() => setConfirmStop(true)}>停止</button>
            </>
          )}
        </div>
      </div>
      {confirmStop ? (
        <div data-testid="group-stop-dialog" role="alertdialog" aria-label="确认停止" className="flex flex-col gap-2 border-b border-hair bg-card/70 px-3 py-2">
          <p className="text-meta text-secondary">
            <span className="text-primary">停止这一轮？</span>会取消待办并打断正在跑的会话，成员暂停到你再次发言。
          </p>
          <div className="flex gap-2">
            <button data-testid="group-stop-confirm" className={DANGER} disabled={stop.isPending} onClick={() => { setConfirmStop(false); stop.mutate(); }}>确认停止</button>
            <button data-testid="group-stop-cancel" className={SMALL} onClick={cancelStop}>取消</button>
          </div>
        </div>
      ) : null}
      <ol data-testid="group-posts" className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {list.map((p, i, all) => {
          const label = authorLabel(p);
          const prev = all[i - 1];
          // 同一个人连着说：只有第一条带头像和名字，后面的缩进对齐
          const run = prev !== undefined && prev.author.kind === p.author.kind && p.author.kind !== 'system' && authorLabel(prev) === label;
          if (p.author.kind === 'system') {
            return (
              <li key={p.id} data-testid="group-post" data-author="system" className="my-1.5">
                <p data-testid="system-line" className="rounded-sm border-l-2 border-accent/40 bg-card/70 px-2 py-1 text-sub text-tertiary">{p.body}</p>
              </li>
            );
          }
          const mine = p.author.kind === 'user';
          return (
            <li key={p.id} data-testid="group-post" data-author={p.author.kind} className={`my-1.5 flex items-start gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
              {mine ? null : run ? <span aria-hidden className="h-5 w-5 shrink-0" /> : <NameDot name={label} external={p.author.kind === 'external'} />}
              <div className={`flex min-w-0 max-w-[85%] flex-col gap-0.5 ${mine ? 'items-end' : 'items-start'}`}>
                {run ? null : (
                  <span className="flex items-center gap-1.5 text-meta text-tertiary">
                    <span className="max-w-[45vw] truncate">{label}</span>
                    <time dateTime={new Date(p.createdAt).toISOString()} className="tabular-nums">{clock(p.createdAt)}</time>
                  </span>
                )}
                <LogMarkdown body={p.body} className={`${BUBBLE_MD} rounded-md px-3 py-1.5 ${mine ? 'bg-accent/15' : 'bg-card'}`} />
                <ReactionBar
                  reactions={p.reactions}
                  me={meName}
                  align={mine ? 'end' : 'start'}
                  error={reactError?.postId === p.id ? reactError.message : null}
                  onToggle={(emoji) => reactTo(p, emoji)}
                />
                {mine && outsidersOf(p.body).length ? (
                  <span className="flex flex-col gap-1">
                    {outsidersOf(p.body).map((role) => (
                      <span key={role} className="mt-1 flex items-center gap-2 text-meta text-tertiary" data-testid="group-outsider" data-role={role}>
                        @{role} 不在群里，只能 @ 群成员
                        {canManage ? (
                          <button className={SMALL} data-testid="group-add-member" data-role={role} disabled={add.isPending} onClick={() => add.mutate({ postId: p.id, role })}>
                            加入群组
                          </button>
                        ) : null}
                      </span>
                    ))}
                  </span>
                ) : null}
                {add.isError && add.variables && add.variables.postId === p.id ? <span className="text-meta text-rust" data-testid="group-add-member-error">{(add.error as Error).message}</span> : null}
              </div>
            </li>
          );
        })}
        {typingText ? <TypingLine line={typingText} /> : null}
        {drafts.map((draft) => (
          <DraftBubble key={draft.sessionId} role={draft.role} body={draft.body} />
        ))}
        <div ref={bottom} />
      </ol>
      <div className="flex items-center gap-2 border-t border-hair px-2 pt-1.5">
        <button
          type="button"
          data-testid="group-host-chip"
          title={
            group.hostRole
              ? group.speakingStrategy === 'host'
                ? '主持人分派发言，点这里改'
                : '发言方式是成员竞价，主持人不分派'
              : '没人分派时，@ 成员也能直接叫人'
          }
          className={`flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-meta ${group.hostRole ? 'border-hair bg-card text-tertiary hover:border-accent hover:text-accent' : 'border-accent/50 bg-accent/10 text-primary hover:border-accent'}`}
          onClick={() => onDrawer('settings', true)}
        >
          {group.hostRole ? (
            <>
              <NameDot name={group.hostRole} size={14} />
              <span className="shrink-0">主持人</span>
              <span className="min-w-0 truncate text-primary">@{group.hostRole}</span>
            </>
          ) : (
            <span className="truncate">未设主持人 · 设置</span>
          )}
        </button>
        {hostBot ? <span className="min-w-0 truncate text-meta text-tertiary">{hostBot.model.trim() || '用默认模型'}</span> : null}
      </div>
      <form
        className="flex items-end gap-2 p-2"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
      >
        <div className="relative min-w-0 flex-1">
          {open ? (
            <ul data-testid="mention-menu" className="absolute bottom-full left-0 z-30 mb-1 max-h-56 w-full overflow-y-auto rounded-md border border-strong bg-panel p-1 shadow-lg">
              {candidates.map((item, i) => (
                <li key={`${item.kind}:${item.token}`}>
                  <button
                    type="button"
                    data-testid="mention-option"
                    data-token={item.token}
                    aria-selected={i === highlighted}
                    className={`flex w-full items-center gap-2 rounded-sm px-1.5 py-1.5 text-left text-meta ${i === highlighted ? 'bg-card' : ''}`}
                    onMouseDown={(e) => { e.preventDefault(); applyMention(item); }}
                    onMouseEnter={() => setPick(i)}
                  >
                    {item.kind === 'member' ? (
                      <NameDot name={item.token} size={18} />
                    ) : (
                      <span aria-hidden className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-card-raised text-[10px] text-tertiary">{item.kind === 'all' ? '∗' : '我'}</span>
                    )}
                    <span className="shrink-0 text-primary">@{item.token}</span>
                    {item.label !== item.token ? <span className="min-w-0 flex-1 truncate text-tertiary">{item.label}</span> : <span className="flex-1" />}
                    {item.note ? <span className={`shrink-0 rounded-sm border px-1 text-[10px] ${item.note.includes('已暂停') ? 'border-rust/40 text-rust' : 'border-hair text-tertiary'}`}>{item.note}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <textarea
            ref={input}
            aria-label="发消息"
            data-testid="group-input"
            className={`${INPUT} min-h-10`}
            placeholder="发到群里，@ 可以点名"
            value={text}
            onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setDismissed(null); }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (open) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setPick((i) => stepMention(i, 1, candidates.length)); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setPick((i) => stepMention(i, -1, candidates.length)); return; }
                if (e.key === 'Escape') { e.preventDefault(); setDismissed(rangeKey); return; }
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                  const item = candidates[highlighted];
                  if (item) { e.preventDefault(); applyMention(item); return; }
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
          />
        </div>
        <button type="submit" data-testid="group-send" aria-label="发送" className={`${SMALL} shrink-0`} disabled={send.isPending || !text.trim()}>
          {compact ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          ) : '发送'}
        </button>
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
  const [drawerHost, setDrawerHost] = useState(false);
  const openDrawer = (d: Drawer, focusHost = false) => { setDrawerHost(focusHost); setDrawer(d); };
  const closeDrawer = () => { setDrawerHost(false); setDrawer(null); };
  const compact = useCompact();
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!more) return;
    const onDown = (e: PointerEvent) => { if (!moreRef.current?.contains(e.target as Node)) setMore(false); };
    const close = () => setMore(false);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('hashchange', close);
    return () => { document.removeEventListener('pointerdown', onDown); window.removeEventListener('hashchange', close); };
  }, [more]);
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
      <header className="flex items-center gap-2 border-b border-hair px-3 py-2">
        <div className={`min-w-0 flex-1 ${compact ? 'flex items-baseline gap-2' : ''}`}>
          <a className="block max-w-full shrink-0 truncate whitespace-nowrap text-meta text-tertiary hover:text-accent" href={formatRoute({ page: 'home' })}>← agent-hub</a>
          <h1 className="min-w-0 truncate text-head text-primary">消息</h1>
        </div>
        <select aria-label="项目" data-testid="messages-project" className={`${INPUT} min-w-0 shrink-0 ${compact ? 'max-w-[45%]' : 'max-w-[40%]'}`} value={pid ?? ''} onChange={(e) => { window.location.hash = formatRoute({ page: 'messages', projectId: e.target.value, groupId: null }); }}>
          {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {compact ? (
          <div className="relative shrink-0" ref={moreRef}>
            <button className={SMALL} data-testid="messages-more" aria-label="更多" aria-expanded={more} onClick={() => setMore((v) => !v)}>⋯</button>
            {more ? (
              <div data-testid="messages-more-menu" className="absolute right-0 top-full z-30 mt-1 flex w-56 flex-col gap-2 rounded-md border border-strong bg-panel p-2 shadow-lg">
                <div onClick={() => setMore(false)}><HubTabs active="messages" projectId={pid} /></div>
                <div className="flex items-center gap-2" onClick={() => setMore(false)}>
                  <MessagesEntry />
                  <span className="text-meta text-tertiary">消息</span>
                </div>
                <div className="flex justify-end border-t border-hair pt-2"><AccountMenu /></div>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <HubTabs active="messages" projectId={pid} />
            <div className="flex shrink-0 items-center gap-2">
              <MessagesEntry />
              <AccountMenu />
            </div>
          </>
        )}
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
                  className={`flex items-start gap-2 border-b border-hair px-3 py-2.5 text-body ${g.id === current?.id ? 'bg-card text-primary' : 'text-secondary hover:bg-card'}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate">{g.name}</span>
                      {unreadOf(g.id) && g.id !== current?.id ? (
                        <span data-testid="group-unread" aria-label={`${unreadOf(g.id)} 条未读`} className="min-w-[18px] rounded-full bg-rust px-1.5 text-center text-meta leading-[18px] text-canvas">
                          {unreadOf(g.id)}
                        </span>
                      ) : null}
                      {g.needsUser ? <span className="shrink-0 rounded-sm border border-rust px-1.5 text-meta text-rust">需要你</span> : null}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1 text-meta text-tertiary">
                      <span data-testid="group-host-marker" className="min-w-0 truncate">{g.hostRole ? `主持人 @${g.hostRole}` : '未设主持人'}</span>
                      <span aria-hidden>·</span>
                      <span className="shrink-0">{g.members.length} 人</span>
                    </span>
                  </span>
                </a>
              </li>
            ))}
            {!list.length ? (
              groups.isLoading || !pid || roles.isLoading || roleList.length ? <Empty text={groups.isLoading ? '加载中…' : pid ? '还没有群' : '先建一个项目'} /> : (
                <li data-testid="messages-empty" className="flex flex-col items-start gap-2 px-3 py-6 text-meta text-tertiary">
                  <span className="text-body text-secondary">还没有 bot，也还没有群</span>
                  <span>先建一个 bot（常驻成员），再把它拉进群里聊。</span>
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
              <Chat group={current} onDrawer={openDrawer} />
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
        <div className="fixed inset-0 z-40 flex items-end bg-black/30 md:items-center md:justify-center" onClick={closeDrawer}>
          <div data-testid="group-drawer" className="max-h-[75vh] w-full overflow-y-auto rounded-t-md border border-strong bg-panel md:w-[480px] md:rounded-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center border-b border-hair px-3 py-2">
              <span className="text-body text-primary">{drawer === 'members' ? '成员' : drawer === 'chains' ? '调用链' : '群设置'}</span>
              <button className={`${SMALL} ml-auto`} onClick={closeDrawer}>关闭</button>
            </div>
            {drawer === 'members' ? <MembersPanel groupId={current.id} projectId={pid} /> : null}
            {drawer === 'chains' ? <ChainsPanel groupId={current.id} projectId={pid} /> : null}
            {drawer === 'settings' ? (
              <GroupForm key={current.updatedAt} projectId={pid} roles={roleList} group={current} onDone={() => closeDrawer()} openAdvanced={drawerHost} />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
