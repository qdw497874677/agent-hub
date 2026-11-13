import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, botsApi, groupApi, tokensApi, type BotColorDto, type BotRecordDto, type MessagingRoleDto } from '../../shell/api.ts';
import { AccountMenu, useAccount } from '../../shell/auth.tsx';
import { formatRoute } from '../../shell/route.ts';
import { INPUT, SMALL, DANGER, errorText, Empty } from '../../shell/admin/shared.tsx';
import { DialogShell } from '../../shell/dialog-shell.tsx';
import { BotConnectors } from './bot-connectors.tsx';
import { BOT_CREDENTIAL_ACTIVE_NOTE, botCredentialBody, botCredentialRevokeConfirm, botCredentialView } from './bot-credential.ts';
import {
  BOT_OPTION_KEY_SUGGESTIONS, BOT_OPTION_VALUE_SUGGESTIONS, BOT_OPTION_VALUE_MAX,
  botOptionRows, botOptionsProblem, botOptionRowProblem, botOptionsInput, flipBotOptionRow,
  newBotOptionRow, type BotOptionRow
} from './bot-options.ts';

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

/** 弹窗按钮：跟 tokens-dialog 一个手感（细边，hover 才亮）。 */
const CRED_BTN =
  'rounded-sm border border-hair px-3 py-2 text-sub text-secondary hover:border-accent hover:text-accent disabled:opacity-40';

/** 明文只露一次的弹窗：遮罩 / Esc / 「我已保存」都算关，关掉就把 bot 重新拉一遍。 */
function CredentialSecret({ secret, onClose }: { secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const code = useRef<HTMLElement | null>(null);
  // navigator.clipboard 只在安全上下文里有（tailnet 上走 http 时没有）；写不进去就选中文本，让人自己按快捷键。
  const copy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(secret);
        setCopied(true);
        return;
      }
    } catch {
      // 落到下面：退回选中文本
    }
    const node = code.current;
    if (!node) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    setHint('浏览器不让直接写剪贴板，已经帮你选中了：按 Ctrl+C（Mac 上 ⌘C）复制。');
  };
  return (
    <DialogShell title="凭据" onClose={onClose} testId="bot-credential-dialog">
      <p className="text-body text-primary">凭据只显示这一次，现在复制保存好</p>
      <p className="mt-1 text-meta text-rust">关掉就再也看不到了；没存下只能重新生成一条。</p>
      <code data-testid="bot-credential-secret" ref={code} className="mt-3 block break-all rounded-sm border border-hair bg-card px-2 py-1.5 font-mono text-[12px] text-primary select-all">{secret}</code>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" data-testid="bot-credential-copy" className={CRED_BTN} onClick={() => void copy()}>
          {copied ? '已复制' : '复制'}
        </button>
        <button type="button" className={CRED_BTN} onClick={onClose}>我已保存</button>
      </div>
      {hint ? <p className="mt-2 text-meta text-tertiary">{hint}</p> : null}
    </DialogShell>
  );
}

/**
 * bot 的独立凭据（ApiToken · kind:'bot'）：签发、看状态、吊销。明文只弹一次。
 * 已签发时状态行是「前缀 · 创建时间 · 最近使用」，窄屏自己折行，前缀允许断字。
 */
function BotCredential({ projectId, bot }: { projectId: string; bot: BotRecordDto }) {
  const client = useQueryClient();
  const [secret, setSecret] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const view = botCredentialView(bot.token, Date.now());
  const refresh = () => client.invalidateQueries({ queryKey: BOTS_KEY });
  const issue = useMutation({
    mutationFn: () => tokensApi.create(botCredentialBody(projectId, bot.name)),
    // 凭据摘要随 bot 列表回来：签发后立刻重拉，关掉明文弹窗时状态已经是「已签发」。
    onSuccess: (result) => { setSecret(result.token); void refresh(); }
  });
  const revoke = useMutation({
    mutationFn: tokensApi.revoke,
    onSuccess: () => { setConfirming(false); void refresh(); }
  });
  const error = issue.error ?? revoke.error;
  return (
    <div data-testid="bot-credential" className="flex flex-col gap-2 rounded-sm border border-hair bg-card p-2">
      <div className="min-w-0">
        <p className="text-meta text-secondary">凭据</p>
        <p className="text-meta text-tertiary">{view.state === 'issued' ? BOT_CREDENTIAL_ACTIVE_NOTE : view.hint}</p>
      </div>
      {view.state === 'issued' ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <code data-testid="bot-credential-prefix" className="min-w-0 break-all font-mono text-[12px] text-primary select-all">{view.prefix}…</code>
            <span className="text-meta text-tertiary">{view.created}</span>
            <span data-testid="bot-credential-last-used" className="text-meta text-tertiary">{view.lastUsed}</span>
            {confirming ? null : (
              <button type="button" data-testid="bot-credential-revoke" className={`${DANGER} shrink-0 sm:ml-auto`} onClick={() => setConfirming(true)}>吊销</button>
            )}
          </div>
          {confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 basis-full text-meta text-rust">{botCredentialRevokeConfirm(bot.name)}</p>
              <button type="button" data-testid="bot-credential-revoke" className={`${DANGER} shrink-0`} disabled={revoke.isPending} onClick={() => revoke.mutate(view.id)}>确认吊销</button>
              <button type="button" className={SMALL} onClick={() => setConfirming(false)}>取消</button>
            </div>
          ) : null}
        </div>
      ) : (
        <button type="button" data-testid="bot-credential-generate" className={`${SMALL} self-start`} disabled={issue.isPending} onClick={() => issue.mutate()}>
          {issue.isPending ? '生成中…' : '生成凭据'}
        </button>
      )}
      {error ? <p data-testid="bot-credential-error" className="text-meta text-rust">{errorText(error)}</p> : null}
      {secret ? <CredentialSecret secret={secret} onClose={() => { setSecret(null); void refresh(); }} /> : null}
    </div>
  );
}

/**
 * 触发器（只读占位）：`GET /api/bots/:id/triggers` 还没落地（C4 开放），
 * 所以这里不编接口调用，只渲染空态。真有了再换成查询。
 */
function BotTriggers() {
  return (
    <div data-testid="bot-triggers" className="flex flex-col gap-1 rounded-sm border border-hair bg-card p-2">
      <p className="text-meta text-secondary">触发器</p>
      <p className="text-meta text-tertiary" data-testid="bot-triggers-empty">还没有触发器</p>
      <p className="text-meta text-tertiary">触发器在 C4 开放。</p>
    </div>
  );
}

function BotForm({ projectId, bot, onDone }: { projectId: string; bot: BotRecordDto | null; onDone: () => void }) {
  const [name, setName] = useState(bot?.name ?? '');
  const [displayName, setDisplayName] = useState(bot?.displayName ?? '');
  const [color, setColor] = useState<BotColorDto>(bot?.color ?? 'amber');
  const [agentId, setAgentId] = useState(bot?.agentId ?? 'pi');
  const [model, setModel] = useState(bot?.model ?? '');
  const [description, setDescription] = useState(bot?.description ?? '');
  const [reuse, setReuse] = useState<MessagingRoleDto['reuse']>(bot?.reuse ?? 'sticky');
  // 启动选项：编辑时还原成行；保存时只收非空键，全空就不传（编辑时传 {} 表示清空）。
  const [options, setOptions] = useState<BotOptionRow[]>(() => botOptionRows(bot?.options));
  const [more, setMore] = useState(false);
  const client = useQueryClient();
  const optionsError = botOptionsProblem(options);
  const setOption = (index: number, patch: Partial<BotOptionRow>) =>
    setOptions((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const save = useMutation({
    mutationFn: () => {
      const input = { displayName: displayName.trim(), color, agentId, model: model.trim(), description, reuse, ...botOptionsInput(options, !!bot) };
      // 编辑只发可改字段（name 建好不改，带了会 400）；新建才带 name。
      return bot ? botsApi.update(bot.id, input) : botsApi.create({ projectId, name: name.trim(), ...input });
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: BOTS_KEY }); void client.invalidateQueries({ queryKey: ['groups'] }); onDone(); }
  });
  const preview = { name: name || '?', displayName, color };
  const known = RUNTIMES.some((r) => r.id === agentId);
  return (
    <form data-testid="bot-form" className="flex flex-col gap-3 rounded-md border border-strong bg-panel p-3" onSubmit={(e) => { e.preventDefault(); if (optionsError) return; save.mutate(); }}>
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
        {bot ? <span className="text-tertiary">@id 建好后只读；要换名字请另建一个 bot，再把旧的删掉。</span> : null}
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
        <>
          <select aria-label="会话复用" data-testid="bot-reuse" className={INPUT} value={reuse} onChange={(e) => setReuse(e.target.value as MessagingRoleDto['reuse'])}>
            <option value="sticky">一直用同一个会话（推荐）</option>
            <option value="per-trace">每条对话链一个会话</option>
            <option value="always-new">每次新开会话</option>
          </select>
          <div data-testid="bot-options" className="flex flex-col gap-2 rounded-sm border border-hair bg-card p-2">
            <div>
              <p className="text-meta text-secondary">启动选项</p>
              <p className="text-meta text-tertiary">建会话时作为默认值；会话里可以再改。</p>
            </div>
            {options.map((row, i) => {
              const rowProblem = botOptionRowProblem(options, i);
              const bad = rowProblem ? { borderColor: 'var(--color-rust)' } : undefined;
              const valueHints = BOT_OPTION_VALUE_SUGGESTIONS[row.key.trim()];
              return (
                <div key={i} className="flex flex-col gap-1">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center">
                    <input
                      data-testid="bot-option-key" aria-label="选项键" className={`${INPUT} min-w-0 font-mono sm:flex-1`}
                      style={bad} list="bot-option-keys" autoComplete="off" spellCheck={false} maxLength={41}
                      placeholder="effort" value={row.key}
                      onChange={(e) => setOption(i, { key: e.target.value })}
                    />
                    <div className="flex min-w-0 items-center gap-1 sm:flex-1">
                      {row.kind === 'text' ? (
                        <input
                          data-testid="bot-option-value" aria-label="选项值" className={`${INPUT} min-w-0 flex-1 font-mono`}
                          style={bad} list={valueHints ? `bot-option-values-${i}` : undefined} autoComplete="off" spellCheck={false} maxLength={BOT_OPTION_VALUE_MAX}
                          placeholder={valueHints ? valueHints.join(' / ') : '值（可留空）'} value={row.text}
                          onChange={(e) => setOption(i, { text: e.target.value })}
                        />
                      ) : (
                        <label className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1.5 text-meta text-secondary">
                          <input
                            type="checkbox" role="switch" data-testid="bot-option-value" aria-label="选项值"
                            className="h-4 w-4 shrink-0 accent-[var(--color-accent)]" checked={row.on}
                            onChange={(e) => setOption(i, { on: e.target.checked })}
                          />
                          {row.on ? '打开' : '关闭'}
                        </label>
                      )}
                      <button
                        type="button" data-testid="bot-option-toggle" className={`${SMALL} shrink-0`}
                        aria-label={row.kind === 'text' ? '切换为开关' : '切换为文本'} aria-pressed={row.kind === 'switch'}
                        title={row.kind === 'text' ? '改成开关（是 / 否）' : '改成文本'}
                        onClick={() => setOptions((rows) => rows.map((r, j) => (j === i ? flipBotOptionRow(r) : r)))}
                      >
                        {row.kind === 'text' ? '开关' : '文本'}
                      </button>
                      <button
                        type="button" data-testid="bot-option-remove" aria-label="删除选项" className={`${DANGER} shrink-0`}
                        onClick={() => setOptions((rows) => rows.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  {valueHints ? (
                    <datalist id={`bot-option-values-${i}`}>
                      {valueHints.map((value) => <option key={value} value={value} />)}
                    </datalist>
                  ) : null}
                  {rowProblem ? <p className="text-meta text-rust">{rowProblem}</p> : null}
                </div>
              );
            })}
            <button type="button" data-testid="bot-option-add" className="self-start text-meta text-tertiary hover:text-secondary" onClick={() => setOptions((rows) => [...rows, newBotOptionRow()])}>
              ＋ 添加选项
            </button>
            <datalist id="bot-option-keys">
              {BOT_OPTION_KEY_SUGGESTIONS.map((key) => <option key={key} value={key} />)}
            </datalist>
            {optionsError ? <p data-testid="bot-options-error" className="text-meta text-rust">{optionsError}</p> : null}
          </div>
        </>
      ) : null}
      {/* 触发器（C4 前只读空态）与凭据只在编辑已有 bot 时给：新建时还没有 bot 记录。 */}
      {bot ? <BotTriggers /> : null}
      {bot ? <BotCredential projectId={projectId} bot={bot} /> : null}
      <div className="flex items-center gap-2">
        <button type="submit" data-testid="bot-save" className={SMALL} disabled={save.isPending || (!bot && !name.trim()) || optionsError !== null}>{bot ? '保存' : '新建 bot'}</button>
        <button type="button" className={SMALL} onClick={onDone}>取消</button>
        {save.error ? <p data-testid="bot-error" className="text-meta text-rust">{errorText(save.error)}</p> : null}
      </div>
    </form>
  );
}

/** 群里引用 bot 的最小信息（groups 不再由 bot 接口给，改为从群列表推导）。 */
type BotGroupRef = { id: string; name: string; host: boolean };

function DeleteConfirm({ bot, groups, onDone }: { bot: BotRecordDto; groups: BotGroupRef[]; onDone: () => void }) {
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () => botsApi.remove(bot.id),
    onSuccess: () => { void client.invalidateQueries({ queryKey: BOTS_KEY }); void client.invalidateQueries({ queryKey: ['groups'] }); onDone(); }
  });
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/30 md:items-center md:justify-center" onClick={onDone}>
      <div data-testid="bot-delete-dialog" role="dialog" aria-label="删除 bot" className="w-full rounded-t-md border border-strong bg-panel p-4 md:w-[420px] md:rounded-md" onClick={(e) => e.stopPropagation()}>
        <p className="text-body text-primary">删除 bot「{botLabel(bot)}」（@{bot.name}）？</p>
        {groups.length ? (
          <>
            <p className="mt-2 text-meta text-secondary">它会从这些群里移出：</p>
            <ul data-testid="bot-delete-groups" className="mt-1 list-disc pl-5 text-meta text-secondary">
              {groups.map((g) => <li key={g.id}>{g.name}{g.host ? '（主持人，删除后这个群没有主持人）' : ''}</li>)}
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
  const bots = useQuery({ queryKey: [...BOTS_KEY, pid], queryFn: () => botsApi.list(pid!), enabled: !!pid });
  // bot 接口不再带 groups：从群列表里按成员推导（与消息页共用一个查询键）。
  const groups = useQuery({ queryKey: ['groups', 'list', pid], queryFn: () => groupApi.list(pid!), enabled: !!pid });
  const groupsOf = (name: string): BotGroupRef[] =>
    (groups.data?.groups ?? []).filter((g) => g.members.includes(name)).map((g) => ({ id: g.id, name: g.name, host: g.hostRole === name }));
  const groupsText = (name: string) => {
    const gs = groupsOf(name);
    return gs.length ? `在 ${gs.map((g) => g.name).join('、')}` : '还没进群';
  };
  const [editing, setEditing] = useState<'new' | string | null>(() => (window.location.hash.endsWith('/new') ? 'new' : null));
  const [deleting, setDeleting] = useState<BotRecordDto | null>(null);
  if (!account) return null;
  const list = bots.data?.bots ?? [];
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
          {list.map((b) => editing === b.id && pid ? (
            <li key={b.id}><BotForm projectId={pid} bot={b} onDone={() => setEditing(null)} /></li>
          ) : (
            <li key={b.id} data-testid="bot-item" data-name={b.name} className="flex items-start gap-3 rounded-md border border-hair bg-card p-3">
              <BotAvatar bot={b} size={36} />
              <div className="min-w-0 flex-1">
                <p className="text-body text-primary">{botLabel(b)} <span className="text-meta text-tertiary">@{b.name}</span></p>
                <p className="text-meta text-secondary">{runtime(b.agentId)} · {b.model || '默认模型'}</p>
                {b.description ? <p className="mt-1 line-clamp-2 text-meta text-tertiary">{b.description}</p> : null}
                <p className="mt-1 text-meta text-tertiary" data-testid="bot-groups">{groupsText(b.name)}</p>
                {pid ? <BotConnectors projectId={pid} name={b.name} /> : null}
              </div>
              <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
                <button className={SMALL} data-testid="bot-edit" onClick={() => setEditing(b.id)}>编辑</button>
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
      {deleting ? <DeleteConfirm bot={deleting} groups={groupsOf(deleting.name)} onDone={() => setDeleting(null)} /> : null}
    </div>
  );
}
