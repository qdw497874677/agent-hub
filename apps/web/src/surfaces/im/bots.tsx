import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, botsApi, groupApi, teamApi, tokensApi, type BotColorDto, type BotRecordDto, type BotTriggerDto, type BotTriggerSourceDto, type MessagingRoleDto, type WorkerInfoDto } from '../../shell/api.ts';
import { AccountMenu, useAccount } from '../../shell/auth.tsx';
import { formatRoute } from '../../shell/route.ts';
import { INPUT, SMALL, DANGER, errorText, Empty } from '../../shell/admin/shared.tsx';
import { DialogShell } from '../../shell/dialog-shell.tsx';
import { BotConnectors } from './bot-connectors.tsx';
import { ModelPicker, SEARCHABLE_AFTER } from '../../atoms/model-picker.tsx';
import { modelsFor } from '../../shell/dialogs.tsx';
import { useWorkers } from '../../shell/workers.tsx';
import { BOT_MODEL_DEFAULT_ITEM, BOT_MODEL_DEFAULT_LABEL, botModelChoices, offListModel } from './bot-models.ts';
import { BOT_TRIGGERS_EMPTY, BOT_TRIGGERS_EMPTY_HINT, latestRun, nextRunView, runView, sourceText, triggerStateView } from './bot-triggers.ts';
import { BOT_CREDENTIAL_ACTIVE_NOTE, botCredentialBody, botCredentialRevokeConfirm, botCredentialView } from './bot-credential.ts';
import {
  BOT_GRANTS_EMPTY, BOT_GRANTS_HINT, BOT_GRANT_PICKER_TITLE, BOT_SCOPE_NOTE,
  grantPickerView, grantRevokeConfirm, grantRowView, projectGrant
} from '../../atoms/bot-grants.ts';
import { workspaceName } from '../../atoms/workspace-format.ts';
import {
  BOT_OPTION_KEY_SUGGESTIONS, BOT_OPTION_VALUE_SUGGESTIONS, BOT_OPTION_VALUE_MAX,
  botOptionRows, botOptionsProblem, botOptionRowProblem, botOptionsInput, flipBotOptionRow,
  newBotOptionRow, type BotOptionRow
} from './bot-options.ts';

/**
 * Bot 页（#/bots[/<项目>]）：常驻成员（Bot）在界面上就叫 bot。
 * 每个 bot 一行：彩色首字头像、显示名、@id、运行时 · 模型、在哪些群。
 * 新建 / 编辑在同一张表单里；@id 建好不改；职责说明 ≤ 4000 字，作为它的系统提示。
 * 删除会先列出它所在的群，确认后从这些群里移出。
 */
export const BOT_COLORS: Record<BotColorDto, string> = {
  amber: '#d9a05b', sage: '#8fae8b', sky: '#7ea6c9', rose: '#c98a8a', olive: '#a9a86a', slate: '#8c96a0'
};
const COLOR_KEYS = Object.keys(BOT_COLORS) as BotColorDto[];
const RUNTIMES = [
  { id: 'pi', label: 'Pi' }, { id: 'opencode', label: 'OpenCode' }, { id: 'grok', label: 'Grok' }, { id: 'hermes', label: 'Hermes' },
  { id: 'codex', label: 'Codex' }
];
const DESCRIPTION_MAX = 4000;
export const BOTS_KEY = ['bots'] as const;

/**
 * 模型清单按当前选中的运行时取：同一台机器上 Pi 配的 provider 和 Grok 的可能完全不同。
 * bot 表单不选机器，所以取所有在线机器上报的并集（按上报顺序，重复只留一条）。
 * 老 Worker 没报 agentModels 时是空清单，界面上退回手填。
 */
function runtimeModels(workers: readonly WorkerInfoDto[], agentId: string): string[] {
  const seen = new Set<string>();
  for (const worker of workers) {
    if (worker.state !== 'online') continue;
    for (const model of modelsFor(workers, worker.workerId, agentId)?.models ?? []) seen.add(model);
  }
  return [...seen];
}

/**
 * 模型一栏：显式的「默认模型（留空）」+ 运行时上报的清单（≤ 8 原生下拉，> 8 可搜索选择器）。
 * 手填入口常开：清单只覆盖运行时自报的那几个，自建模型、没上报的机器都得能直接写。
 * 值始终写回同一个字段，空串继续合法（= 运行时默认）。
 */
function BotModelField({ agentId, model, onChange }: { agentId: string; model: string; onChange: (value: string) => void }) {
  const workers = useWorkers();
  const models = useMemo(() => runtimeModels(workers.list, agentId), [workers.list, agentId]);
  const choices = useMemo(() => botModelChoices(models, model), [models, model]);
  const offList = offListModel(models, model);
  // 手填 / 列表是「在这台运行时上的一次点击」：跟着 agentId 记，换运行时重新判断，别把上一台的口径带过来。
  // 没点过时看值：清单外的老值直接进手填，能看见也能改（别只剩下拉里一条「清单外」）。
  const [manualPref, setManualPref] = useState<{ agentId: string; manual: boolean } | null>(null);
  const pref = manualPref?.agentId === agentId ? manualPref.manual : null;
  // 清单空（机器没上报、或这个运行时没配模型）：没有可点的东西，直接给手填，也不给没用的切换链接。
  const showManual = models.length === 0 || (pref ?? offList !== null);
  return (
    <div data-testid="bot-model-field" className="flex min-w-0 flex-col gap-1 text-meta text-secondary">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="min-w-0">模型 <span className="text-tertiary">（留空用运行时默认）</span></span>
        {models.length > 0 ? (
          <button
            type="button" data-testid="bot-model-manual" aria-pressed={showManual}
            className="ml-auto shrink-0 text-meta text-tertiary hover:text-secondary hover:underline"
            onClick={() => setManualPref({ agentId, manual: !showManual })}
          >{showManual ? '从清单里选' : '手动输入模型 id'}</button>
        ) : null}
      </div>
      {showManual ? (
        <input
          data-testid="bot-model" aria-label="模型" className={INPUT} maxLength={200}
          placeholder="比如：deepseek-v3" value={model}
          // 开始手填就钉在手填模式：清单可能还在路上（worker 没回），别把人正打字时的框换成下拉。
          onChange={(event) => { setManualPref({ agentId, manual: true }); onChange(event.target.value); }}
        />
      ) : choices.items.length > SEARCHABLE_AFTER ? (
        <div data-testid="bot-model-select" className="min-w-0">
          <ModelPicker
            id="bot-model-picker" className={INPUT} scope={agentId} label="模型"
            value={model} items={[BOT_MODEL_DEFAULT_ITEM, ...choices.items]} note={choices.note}
            onChange={onChange}
          />
        </div>
      ) : (
        <>
          <select
            data-testid="bot-model-select" aria-label="模型" className={INPUT} value={model}
            onChange={(event) => onChange(event.target.value)}
          >
            <option data-testid="bot-model-default" value="">{BOT_MODEL_DEFAULT_LABEL}</option>
            {choices.items.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            {/* 清单外的旧值补一条：受控 select 找不到匹配项会显示成第一项，看着像被改成了默认 */}
            {offList ? <option value={offList}>{offList}（清单外）</option> : null}
          </select>
          {choices.note ? <p className="text-tertiary">{choices.note}</p> : null}
        </>
      )}
      {models.length === 0 ? <p data-testid="bot-model-empty" className="text-tertiary">这台机器还没上报模型</p> : null}
    </div>
  );
}

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
 * 触发器（只读）：`GET /api/bots/:id/triggers` 回来的绑定 + 最近一次 run。
 * 创建 / 暂停在连接器页；这里只读。接口没上线（404/501）时 api 层给空表，落空态。
 * 窄屏靠 flex-wrap + min-w-0 + break-words 分行，不出现横向滚动。
 */
function BotTriggers({ bot }: { bot: BotRecordDto }) {
  const now = Date.now();
  const triggers = useQuery({ queryKey: ['bot-triggers', bot.id], queryFn: () => botsApi.triggers(bot.id), refetchInterval: 30_000 });
  const bindings = triggers.data?.bindings ?? [];
  return (
    <div data-testid="bot-triggers" className="flex min-w-0 flex-col gap-2 rounded-sm border border-hair bg-card p-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <p className="text-meta text-secondary">触发器</p>
        <p className="text-meta text-tertiary">来自连接器页 · 只读</p>
      </div>
      {triggers.isLoading ? <p className="text-meta text-tertiary">加载中…</p> : null}
      {!triggers.isLoading && !triggers.error && !bindings.length ? (
        <div className="flex flex-col gap-0.5">
          <p data-testid="bot-triggers-empty" className="text-meta text-tertiary">{BOT_TRIGGERS_EMPTY}</p>
          <p className="text-meta text-tertiary">{BOT_TRIGGERS_EMPTY_HINT}</p>
        </div>
      ) : null}
      {bindings.length ? (
        <ul className="flex min-w-0 flex-col gap-1.5">
          {bindings.map((t) => <BotTriggerRow key={t.id} trigger={t} projectId={bot.projectId ?? ''} now={now} sources={triggers.data?.sources} />)}
        </ul>
      ) : null}
      {triggers.error ? <p className="text-meta text-rust">{errorText(triggers.error)}</p> : null}
    </div>
  );
}

function BotTriggerRow({ trigger, projectId, now, sources }: {
  trigger: BotTriggerDto;
  projectId: string;
  now: number;
  sources?: readonly BotTriggerSourceDto[];
}) {
  const state = triggerStateView(trigger);
  const next = nextRunView(trigger, now);
  const run = latestRun(trigger.runs);
  const tone = state.tone === 'on'
    ? 'border-accent/60 text-accent'
    : state.tone === 'paused' ? 'border-rust/60 text-rust' : 'border-hair text-tertiary';
  return (
    <li data-testid="bot-trigger" data-id={trigger.id} data-connector={trigger.connector}
      className="flex min-w-0 flex-col gap-1 rounded-sm border border-hair p-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-words text-body text-primary">{trigger.name}</span>
        <span className="min-w-0 break-words text-meta text-tertiary">{sourceText(trigger, sources)}</span>
        <span data-testid="bot-trigger-state" data-tone={state.tone}
          className={`shrink-0 rounded-full border px-1.5 py-px text-meta ${tone}`}>{state.label}</span>
      </div>
      {trigger.pausedReason ? <p className="min-w-0 break-words text-meta text-rust">{trigger.pausedReason}</p> : null}
      <p data-testid="bot-trigger-next" data-tone={next.tone} className={`min-w-0 break-words text-meta ${next.tone === 'overdue' ? 'text-rust' : 'text-secondary'}`}>
        {next.prefix ? `${next.prefix} ` : ''}{next.text}
      </p>
      <div data-testid="bot-trigger-run" data-state={run?.state ?? 'none'}
        className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-meta text-tertiary">
        {run ? (
          <>
            <span className="min-w-0 break-words">最近 {runView(run, now)}</span>
            {run.reason ? <span className="min-w-0 break-words">{run.reason}</span> : null}
            {run.sessionId ? (
              <a className="shrink-0 text-accent hover:underline"
                href={formatRoute({ page: 'project', projectId, view: 'focus', sessionId: run.sessionId })}>打开会话</a>
            ) : null}
          </>
        ) : <span>还没跑过</span>}
      </div>
    </li>
  );
}

/**
 * 项目授权（bot 归团队，项目只是授权）：列出这个 bot 的每条授权，只有本项目那条能撤销。
 * 撤销要二次确认——它会被移出本项目的群，@ 也不再响应，而群成员是快照，不会自己跟着变。
 * 窄屏一行一块（项目名 / 工作目录 / 按钮各占整行），不出现横向滚动。
 */
function BotGrants({ bot, projectId }: { bot: BotRecordDto; projectId: string }) {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const grants = useQuery({ queryKey: ['bot-grants', bot.id], queryFn: () => botsApi.grants(bot.id) });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  // 键与工作目录页共用：同一份团队工作目录清单，不重复拉。
  const workspaces = useQuery({ queryKey: ['team-workspaces'], queryFn: api.teamWorkspaces });
  const rows = grants.data?.grants ?? [];
  const projectNames = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p.name])), [projects.data]);
  const workspaceNames = useMemo(
    () => new Map((workspaces.data ?? []).map((row) => [row.workspace.id, workspaceName(row.workspace)])),
    [workspaces.data]
  );
  // 本项目已有授权 = 不显示「授权到这个项目」，那条授权行上才有「撤销」。
  const here = projectGrant(rows, projectId);
  const hereName = projectNames.get(projectId)?.trim() || projectId;
  const refresh = () => {
    void client.invalidateQueries({ queryKey: BOTS_KEY });
    void client.invalidateQueries({ queryKey: ['bot-grants', bot.id] });
    void client.invalidateQueries({ queryKey: ['groups'] });
  };
  const add = useMutation({ mutationFn: () => botsApi.grant(bot.id, projectId), onSuccess: refresh });
  const revoke = useMutation({
    mutationFn: () => botsApi.revoke(bot.id, projectId),
    onSuccess: () => { setConfirming(false); refresh(); }
  });
  const error = add.error ?? revoke.error;
  return (
    <div data-testid="bot-grants" className="flex min-w-0 flex-col gap-2 rounded-sm border border-hair bg-card p-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <p className="text-meta text-secondary">项目授权</p>
        <p className="min-w-0 text-meta text-tertiary">{BOT_GRANTS_HINT}</p>
      </div>
      {grants.isLoading ? <p className="text-meta text-tertiary">加载中…</p> : null}
      {!grants.isLoading && !rows.length ? (
        <p data-testid="bot-grants-empty" className="text-meta text-tertiary">{BOT_GRANTS_EMPTY}</p>
      ) : null}
      {rows.length ? (
        <ul className="flex min-w-0 flex-col gap-1.5">
          {rows.map((grant) => {
            const view = grantRowView(grant, projectNames.get(grant.projectId), workspaceNames);
            const isHere = grant.projectId === projectId;
            return (
              <li key={grant.projectId} data-testid="bot-grant-row" data-project={grant.projectId}
                className="flex min-w-0 flex-col gap-1 rounded-sm border border-hair p-2 sm:flex-row sm:items-center sm:gap-2">
                <div className="min-w-0 flex-1">
                  <p className="min-w-0 break-words text-body text-primary">
                    {view.project}{isHere ? <span className="ml-1 text-meta text-tertiary">（本项目）</span> : null}
                  </p>
                  <p className="min-w-0 break-words text-meta text-tertiary">{view.workspace}</p>
                </div>
                {isHere ? (confirming ? (
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="min-w-0 basis-full text-meta text-rust">{grantRevokeConfirm(botLabel(bot), view.project)}</p>
                    <button type="button" data-testid="bot-grant-revoke" className={DANGER} disabled={revoke.isPending} onClick={() => revoke.mutate()}>
                      {revoke.isPending ? '撤销中…' : '确认撤销'}
                    </button>
                    <button type="button" className={SMALL} onClick={() => setConfirming(false)}>取消</button>
                  </div>
                ) : (
                  <button type="button" data-testid="bot-grant-revoke" className={`${DANGER} self-start sm:shrink-0`} onClick={() => setConfirming(true)}>
                    撤销本项目
                  </button>
                )) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {grants.error ? <p className="text-meta text-rust">{errorText(grants.error)}</p> : null}
      {!here && !grants.isLoading ? (
        <button type="button" data-testid="bot-grant-add" className={`${SMALL} self-start`} disabled={add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? '授权中…' : `授权到「${hereName}」`}
        </button>
      ) : null}
      {error ? <p data-testid="bot-grant-error" className="text-meta text-rust">{errorText(error)}</p> : null}
    </div>
  );
}

/**
 * 「授权已有 bot」：团队里还没授权到本项目的 bot，点一个就授权。
 * 只从团队清单里挑——本项目的列表里已经没有它们了（授权撤销后就不在）。
 */
function GrantPicker({ teamId, projectId, grantedIds, onClose }: {
  teamId: string;
  projectId: string;
  grantedIds: readonly string[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const team = useQuery({ queryKey: ['team-bots', teamId], queryFn: () => botsApi.team(teamId) });
  const view = grantPickerView(team.data?.bots ?? [], grantedIds, team.isLoading);
  const grant = useMutation({
    mutationFn: (botId: string) => botsApi.grant(botId, projectId),
    onSuccess: () => { void client.invalidateQueries({ queryKey: BOTS_KEY }); onClose(); }
  });
  const runtime = (id: string) => RUNTIMES.find((r) => r.id === id)?.label ?? id;
  return (
    <DialogShell title={BOT_GRANT_PICKER_TITLE} onClose={onClose} testId="bot-grant-picker">
      <p className="text-meta text-tertiary">从团队里挑一个 bot，授权到这个项目；授权后它才出现在这个列表里，也能拉进本项目的群。</p>
      {team.isLoading ? <p className="mt-2 text-meta text-tertiary">加载中…</p> : null}
      {view.empty && !team.isError ? <p data-testid="bot-grant-picker-empty" className="mt-2 text-meta text-tertiary">{view.empty}</p> : null}
      {view.items.length ? (
        <ul data-testid="bot-grant-picker-list" className="mt-2 flex max-h-[60dvh] min-w-0 flex-col gap-1.5 overflow-y-auto overscroll-contain">
          {view.items.map((b) => (
            <li key={b.id} className="min-w-0">
              <button type="button" data-testid="bot-grant-option" data-id={b.id} data-name={b.name}
                className="flex w-full min-w-0 items-start gap-2 rounded-sm border border-hair bg-card p-2 text-left hover:border-accent disabled:opacity-40"
                disabled={grant.isPending} onClick={() => grant.mutate(b.id)}>
                <BotAvatar bot={b} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block min-w-0 break-words text-body text-primary">
                    {botLabel(b)} <span className="text-meta text-tertiary">@{b.name}</span>
                  </span>
                  <span className="block min-w-0 break-words text-meta text-tertiary">{runtime(b.agentId)} · {b.model || '默认模型'}</span>
                </span>
                <span className="shrink-0 text-meta text-tertiary">{grant.isPending && grant.variables === b.id ? '授权中…' : '授权'}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {team.error ? <p className="mt-2 text-meta text-rust">{errorText(team.error)}</p> : null}
      {grant.error ? <p data-testid="bot-grant-picker-error" className="mt-2 text-meta text-rust">{errorText(grant.error)}</p> : null}
    </DialogShell>
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
      <BotModelField agentId={agentId} model={model} onChange={setModel} />
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
      {/* 触发器与凭据只在编辑已有 bot 时给：新建时还没有 bot 记录。 */}
      {/* 授权段要有团队上下文：拿不到 teamId 就整段不出现，不留死按钮。 */}
      {bot && bot.teamId ? <BotGrants bot={bot} projectId={projectId} /> : null}
      {bot ? <BotTriggers bot={bot} /> : null}
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
  // 团队上下文（项目授权、团队 bot 清单都要它）：拿不到就不显示任何授权入口。
  const team = useQuery({ queryKey: ['team'], queryFn: teamApi.team, enabled: !!account });
  const teamId = team.data?.id ?? null;
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
  const [picking, setPicking] = useState(false);
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
        <div className="flex flex-wrap items-start gap-2">
          <p data-testid="bots-scope-note" className="min-w-0 text-meta text-tertiary">{BOT_SCOPE_NOTE}</p>
          <div className="ml-auto flex shrink-0 flex-wrap gap-1.5">
            {/* 列表非空时也要能「把团队里已有的拿过来」，否则第 N 个 bot 没入口。 */}
            {pid && teamId && !bots.isLoading ? (
              <button data-testid="bot-grant-open" className={SMALL} onClick={() => setPicking(true)}>
                {BOT_GRANT_PICKER_TITLE}
              </button>
            ) : null}
            {pid && editing !== 'new' ? <button data-testid="bot-new" className={SMALL} onClick={() => setEditing('new')}>新建 bot</button> : null}
          </div>
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
            <Empty text={bots.isLoading ? '加载中…' : pid ? '本项目还没有授权任何 bot。新建一个，或授权一个团队里已有的。' : '先建一个项目'} />
          </div>
        ) : null}
      </main>
      {deleting ? <DeleteConfirm bot={deleting} groups={groupsOf(deleting.name)} onDone={() => setDeleting(null)} /> : null}
      {picking && pid && teamId ? (
        <GrantPicker teamId={teamId} projectId={pid} grantedIds={list.map((b) => b.id)} onClose={() => setPicking(false)} />
      ) : null}
    </div>
  );
}
