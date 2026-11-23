import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { call, post } from '../../shell/api/http.ts';
import type { DelegationDto, DelegationState } from '../../atoms/delegation-types.ts';
import {
  DELEGATION_STATE_LABEL,
  delegationStatusLine,
  isSha,
  shortSha
} from '../../atoms/delegation.ts';
import { DialogShell, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';

/**
 * 派工验收 + 测试证据（docs/design/vibex-borrowing.md 第二期 V4 / V6 / V7）。
 *
 * 这一块只做三件互不冒充的事：
 * - 显示执行阶段（服务端记的状态，不由界面推）；
 * - 人工验收：只对「服务端当场读到的完整 HEAD」记录，必须勾选核对过那个 SHA；
 * - 自动测试证据：Hub 现在没有可信测试结果记录，就明说「未记录」，
 *   不把人工验收写成测试通过，也不从聊天文字猜。
 *
 * 验收记录不锁工作树：HEAD 变了就重新读，旧记录保留但标注「当前未验收」。
 */

export type DelegationAcceptanceStatus = 'none' | 'accepted' | 'changed' | 'unavailable';

/** 与 `apps/server/src/workspace-delegation-acceptance.ts` 的对外视图一一对应。 */
export interface DelegationAcceptanceEntryDto {
  readonly requestKey: string;
  readonly sha: string;
  readonly createdAt: number;
  readonly note: string | null;
}

export interface DelegationAcceptanceViewDto {
  readonly delegationId: string;
  readonly state: DelegationState;
  readonly history: readonly DelegationAcceptanceEntryDto[];
  /** 按时间排的最后一条，不代表它对应的提交就是当前 HEAD。 */
  readonly latest: DelegationAcceptanceEntryDto | null;
  /** 全量历史里 sha 恰等于当前 HEAD 的那条；没有就是 null。 */
  readonly current: DelegationAcceptanceEntryDto | null;
  readonly headSha: string | null;
  readonly headUnavailable: string | null;
  readonly headObservedAt: number | null;
  readonly status: DelegationAcceptanceStatus;
  /**
   * 服务端判定的「现在能不能新增验收」：派工 prepared、读到了 HEAD、
   * 没归档、任务还在更新。界面照它决定是否给动作，不自己拼条件。
   */
  readonly canAccept: boolean;
}

export interface DelegationAcceptanceSubmitDto {
  readonly delegationId: string;
  readonly outcome: 'created' | 'replayed';
  readonly acceptance: DelegationAcceptanceEntryDto;
}

const acceptancePath = (delegationId: string) =>
  `/api/workspace-delegations/${encodeURIComponent(delegationId)}/acceptance`;

const acceptanceApi = {
  read: (delegationId: string) => call<DelegationAcceptanceViewDto>(acceptancePath(delegationId)),
  /** 服务端会再核一次 HEAD：不一致就 409，界面必须重新读，不许拿旧 SHA 硬发。 */
  accept: (delegationId: string, body: { requestKey: string; expectedHeadSha: string; note: string | null }) =>
    post<DelegationAcceptanceSubmitDto>(acceptancePath(delegationId), body)
};

function freshKey(): string {
  const value = String(globalThis.crypto?.randomUUID?.() ?? '');
  return value === '' ? `key-${Date.now().toString(36)}` : value;
}

function when(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

interface Summary {
  readonly tone: 'ok' | 'warn' | 'danger' | 'idle';
  readonly title: string;
  readonly detail: string;
}

const TONE_TEXT: Record<Summary['tone'], string> = {
  ok: 'text-sage',
  warn: 'text-secondary',
  danger: 'text-rust',
  idle: 'text-tertiary'
};

/** 当前性标签：只有「服务端读到的 HEAD」和某条历史记录的 sha 一致时才叫已验收。 */
export function acceptanceSummary(view: DelegationAcceptanceViewDto): Summary {
  const latest = view.latest;
  const current = view.current;
  if (view.status === 'accepted' && current !== null) {
    return {
      tone: 'ok',
      title: `当前已验收 · ${shortSha(current.sha)}`,
      detail: '服务端刚读到的工作树 HEAD 与这条验收记录一致。'
    };
  }
  if (view.status === 'changed' && latest !== null) {
    return {
      tone: 'warn',
      title: '当前提交还没验收',
      detail: `最近一次验收记录在 ${shortSha(latest.sha)}，现在工作树是 ${shortSha(view.headSha ?? '')}。旧记录保留，但不继承到新提交。`
    };
  }
  if (view.status === 'unavailable') {
    const reason = view.headUnavailable?.trim() || '派工还没有可核对的工作树';
    return {
      tone: 'danger',
      title: '无法确认当前验收状态',
      detail: latest === null ? `${reason}；也还没有验收记录。` : `最近一次验收记录在 ${shortSha(latest.sha)}；${reason}。`
    };
  }
  return {
    tone: 'idle',
    title: '还没验收过',
    detail: '验收只针对执行工作树当时的确切提交；分支名和会话结束都不算验收。'
  };
}

/**
 * 一条派工的验收面。
 *
 * 只在能从派工 DTO 证明执行会话存在时由面板打开（没有执行会话就没有可验收的工作树）。
 * 打开后手动刷新：不轮询，也不凭打开那一刻的 HEAD 一直当真。
 */
export function DelegationEvidenceDialog({
  record,
  taskTitle,
  onClose
}: {
  record: DelegationDto;
  taskTitle: string | null;
  onClose: () => void;
}) {
  const { data, error, isPending, isFetching, dataUpdatedAt, refetch } = useQuery({
    // 派工自己的验收记录：和列表 / 发布状态分开缓存，不串。
    queryKey: ['delegation-acceptance', record.id] as const,
    queryFn: () => acceptanceApi.read(record.id),
    staleTime: 0,
    retry: false
  });
  const view = data ?? null;
  /**
   * TanStack 在刷新失败时会留着上一次的 data。那只是历史，不能再当成
   * 「当前状态」；状态标签、canAccept、勾选都不能沿用它。
   */
  const stale = view !== null && error !== null;
  /**
   * 勾选绑定的是「哪一次读取里看到的哪个完整 SHA」。
   * 每次成功读取都换 observationKey——A→B→A 也不会把之前的勾选带回来；
   * 提交成功后也清空，下一次必须重新核对。
   */
  const [checkedFor, setCheckedFor] = useState<{ key: string; sha: string } | null>(null);
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** 同一段内容（SHA + 备注）的重试原样复用请求键；内容一变就是新键。 */
  const requestKeys = useRef(new Map<string, string>());

  const observationKey = view === null ? 'none' : `${dataUpdatedAt}:${view.headObservedAt ?? 'na'}`;
  const readyHead = view !== null && isSha(view.headSha) ? view.headSha : null;
  const checked =
    readyHead !== null && checkedFor !== null && checkedFor.key === observationKey && checkedFor.sha === readyHead;
  const recheckNote =
    checkedFor !== null && !checked && readyHead !== null
      ? checkedFor.sha !== readyHead
        ? `当前提交已经换成 ${shortSha(readyHead)}；你之前核对的是 ${shortSha(checkedFor.sha)}。重新核对上面的完整值之后才能验收。`
        : '工作树已经重新读取过；请重新核对上面的完整值再记录。'
      : null;
  /** 刷新失败时后端保留的 accepted 不算数。 */
  const accepted = view !== null && view.status === 'accepted' && !stale;
  // 勾选只是界面的确认动作；能不能记由服务端给的 canAccept 说了算。
  const formVisible = view !== null && view.canAccept && readyHead !== null && !accepted && !stale;
  const writeBlocked = busy || isFetching || stale;
  const cannotAcceptPrepared =
    view !== null && view.state === 'prepared' && !view.canAccept && !accepted && !stale && readyHead !== null;
  const summary = view === null ? null : acceptanceSummary(view);

  const requestKeyFor = (sha: string, note: string | null): string => {
    const content = `${sha}\u0000${note ?? ''}`;
    const existing = requestKeys.current.get(content);
    if (existing !== undefined) return existing;
    const key = freshKey();
    requestKeys.current.set(content, key);
    return key;
  };

  const reload = () => {
    setFailure(null);
    setCheckedFor(null);
    void refetch();
  };

  const accept = async () => {
    if (!formVisible || writeBlocked || readyHead === null || !checked) return;
    const note = noteText.trim() === '' ? null : noteText;
    setBusy(true);
    setFailure(null);
    try {
      await acceptanceApi.accept(record.id, {
        requestKey: requestKeyFor(readyHead, note),
        expectedHeadSha: readyHead,
        note
      });
      setCheckedFor(null);
      setNoteText('');
      await refetch();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : '验收没有记上，请重试');
      // 失败常见原因是 HEAD 已经变了：立刻重读，旧的勾选和旧 SHA 都不能继续用。
      setCheckedFor(null);
      await refetch();
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
        关闭
      </button>
      {formVisible ? (
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={writeBlocked || !checked}
          onClick={() => void accept()}
          data-testid="delegation-accept"
        >
          {busy ? '正在记录…' : '记录人工验收'}
        </button>
      ) : null}
    </div>
  );

  return (
    <DialogShell title="验收与测试证据" onClose={onClose} testId="delegation-evidence" footer={footer}>
      <div className="space-y-3">
        <div className="min-w-0">
          <p className="truncate text-sub text-primary" data-testid="evidence-task">
            {taskTitle ?? record.taskId}
          </p>
          <p className="mt-0.5 break-words text-meta text-tertiary" data-testid="evidence-dispatch">
            {DELEGATION_STATE_LABEL[record.state]} · {delegationStatusLine(record)} · {record.branch}
          </p>
        </div>

        {isPending && view === null ? <p className="text-meta text-tertiary">正在读验收记录…</p> : null}

        {error !== null ? (
          <div className="space-y-2" data-testid="evidence-error">
            <p role="alert" className="text-meta text-rust">
              {error instanceof Error ? error.message : '验收记录暂时读不到'}
            </p>
            <button type="button" className={SECONDARY_BUTTON} onClick={reload} data-testid="evidence-reload">
              重新读取
            </button>
          </div>
        ) : null}

        {view !== null && summary !== null ? (
          <>
            <div
              className="rounded-control border border-hair px-2.5 py-2"
              data-testid="acceptance-state"
              data-status={stale ? 'stale' : view.status}
            >
              <div className="flex items-start justify-between gap-2">
                {stale ? (
                  <p className="text-meta font-medium text-rust" data-testid="acceptance-title">
                    验收记录暂时读不到
                  </p>
                ) : (
                  <p className={`text-meta font-medium ${TONE_TEXT[summary.tone]}`} data-testid="acceptance-title">
                    {summary.title}
                  </p>
                )}
                <button
                  type="button"
                  className="shrink-0 rounded-sm px-1 text-meta text-tertiary hover:text-primary disabled:opacity-50"
                  onClick={reload}
                  disabled={isFetching}
                  data-testid="acceptance-reload"
                >
                  {isFetching ? '读取中…' : '刷新'}
                </button>
              </div>
              {stale ? (
                <p className="mt-0.5 text-meta text-secondary">
                  下面是上一次成功读到的验收历史，可能已经过期；重新读取成功之前不能记录新的验收，旧的「已验收」也不再算当前状态。
                </p>
              ) : (
                <p className="mt-0.5 text-meta text-secondary">{summary.detail}</p>
              )}
            </div>

            <div className="rounded-control border border-hair px-2.5 py-2">
              <p className="text-meta text-tertiary">
                {stale ? '上一次读到的执行工作树提交（可能已过期）' : '执行工作树当前提交（服务端当场读取）'}
              </p>
              {readyHead !== null ? (
                <>
                  <p className="mt-0.5 select-all break-all font-mono text-sub text-primary" data-testid="acceptance-head">
                    {readyHead}
                  </p>
                  {view.headObservedAt !== null ? (
                    <p className="mt-0.5 text-meta text-tertiary">读取于 {when(view.headObservedAt)}</p>
                  ) : null}
                </>
              ) : (
                <p className="mt-0.5 text-meta text-rust" data-testid="acceptance-head-missing">
                  {view.headUnavailable?.trim() || '派工还没就绪，没有可核对的工作树'}
                </p>
              )}
            </div>

            {formVisible ? (
              <div className="space-y-2 rounded-control border border-hair px-2.5 py-2" data-testid="acceptance-form">
                <p className="text-meta text-tertiary">人工验收</p>
                {isFetching ? (
                  <p role="status" className="text-meta text-tertiary" data-testid="acceptance-refreshing">
                    正在重新读取工作树，暂时不能记录；读完要重新核对。
                  </p>
                ) : null}
                {recheckNote !== null ? (
                  <p role="status" className="text-meta text-rust" data-testid="acceptance-head-changed">
                    {recheckNote}
                  </p>
                ) : null}
                <label className="flex items-start gap-2 text-meta text-secondary">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0"
                    checked={checked}
                    disabled={writeBlocked}
                    onChange={(event) =>
                      setCheckedFor(
                        event.target.checked && readyHead !== null
                          ? { key: observationKey, sha: readyHead }
                          : null
                      )
                    }
                    data-testid="acceptance-confirm"
                  />
                  <span>
                    我核对过当前提交 <code className="font-mono text-primary">{shortSha(readyHead)}</code>
                    （完整值见上），确认按这个提交记一次人工验收。
                  </span>
                </label>
                <label className="block text-meta text-tertiary">
                  备注（可选）
                  <textarea
                    className={`${INPUT} mt-1 min-h-16 resize-y`}
                    value={noteText}
                    maxLength={2000}
                    disabled={writeBlocked}
                    placeholder="例如：验收范围、已知问题"
                    onChange={(event) => setNoteText(event.target.value)}
                    data-testid="acceptance-note"
                  />
                </label>
              </div>
            ) : null}

            {accepted && view.current !== null ? (
              <div className="space-y-1" data-testid="acceptance-current">
                <p className="text-meta text-secondary">
                  当前提交已经按这条记录验收过；工作树再提交新改动时会自动变成「当前未验收」。
                </p>
                {view.current.note !== null && view.current.note.trim() !== '' ? (
                  <p className="whitespace-pre-wrap break-words text-meta text-tertiary">
                    验收备注：{view.current.note}
                  </p>
                ) : null}
              </div>
            ) : null}

            {cannotAcceptPrepared ? (
              <p className="text-meta text-secondary" data-testid="acceptance-not-allowed">
                服务端现在不允许新增验收（派工可能已归档，或任务已不再更新）。已有记录只作历史。
              </p>
            ) : null}

            {!stale && view.state !== 'prepared' ? (
              <p className="text-meta text-secondary" data-testid="acceptance-unprepared">
                派工当前是「{DELEGATION_STATE_LABEL[view.state]}」，没有可核对的工作树，不能新增验收；已有记录只作历史。
              </p>
            ) : null}

            {failure !== null ? (
              <p role="alert" className="rounded-control border border-rust/60 px-2.5 py-2 text-meta text-rust" data-testid="acceptance-error">
                {failure}
              </p>
            ) : null}

            <div className="rounded-control border border-hair px-2.5 py-2" data-testid="delegation-test-evidence" data-state="not-recorded">
              <p className="text-meta text-tertiary">
                自动测试证据 <span className="rounded-sm border border-hair px-1.5 py-0.5 text-tertiary">未记录</span>
              </p>
              <p className="mt-1 text-meta text-secondary">
                Hub 目前没有可信的测试结果记录。人工验收只表示有人核对过这个提交，不代表测试通过。
              </p>
            </div>

            <div data-testid="acceptance-history">
              <div className="flex items-center justify-between gap-2">
                <p className="text-meta text-tertiary">
                  {stale ? '上一次读到的验收历史' : '验收历史'}
                  {view.history.length > 0 ? ` · ${view.history.length} 条` : ''}
                </p>
              </div>
              {view.history.length === 0 ? (
                <p className="mt-1 text-meta text-tertiary" data-testid="acceptance-history-empty">
                  还没有验收记录。
                </p>
              ) : (
                <ol className="mt-1 max-h-44 space-y-1 overflow-y-auto overscroll-contain">
                  {[...view.history].reverse().map((entry) => (
                    <li
                      key={entry.requestKey}
                      className="rounded-control border border-hair px-2 py-1.5"
                      data-testid="acceptance-history-entry"
                      data-sha={entry.sha}
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="select-all break-all font-mono text-meta text-secondary">{entry.sha}</span>
                        <span className="text-meta text-tertiary">{when(entry.createdAt)}</span>
                        {!stale && view.latest !== null && entry.requestKey === view.latest.requestKey ? (
                          <span className="text-meta text-tertiary">最近一次</span>
                        ) : null}
                        {!stale && view.current !== null && entry.requestKey === view.current.requestKey ? (
                          <span className="text-meta text-secondary">当前验收</span>
                        ) : null}
                      </div>
                      {entry.note !== null && entry.note.trim() !== '' ? (
                        <p className="mt-0.5 whitespace-pre-wrap break-words text-meta text-secondary">{entry.note}</p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </>
        ) : null}

        <HandoffSection record={record} />
      </div>
    </DialogShell>
  );
}

/* ------------------------------------------------------------------ *
 * 转交记录（handoff）
 *
 * 只读的事实：这条派工的执行会话曾经收到过什么。投递状态 ≠ 执行结果，
 * 消息里的候选提交只是消息带的引用（服务端核对过字段，不代表提交可用或已验收），
 * 界面不许把它写成通过、已合并或测试结果。
 * ------------------------------------------------------------------ */

export type DelegationHandoffTransport = 'inbox' | 'queued' | 'delivered' | 'held' | 'failed' | 'unknown';

/** 服务端只回白名单元数据；界面照实显示，不把任何一项变成可点链接。 */
export type DelegationHandoffAttachment =
  | { readonly kind: 'ref'; readonly repo: string; readonly branch: string | null; readonly sha: string | null }
  | { readonly kind: 'link'; readonly url: string; readonly label: string | null }
  | { readonly kind: 'file' };

export interface DelegationHandoffRecordDto {
  readonly messageId: string;
  readonly sentAt: number;
  readonly transport: DelegationHandoffTransport;
  readonly failure: string | null;
  readonly holdReason: string | null;
  readonly deliveredAt: number | null;
  readonly readAt: number | null;
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly candidate: { readonly repoId: string; readonly sha: string } | null;
  readonly attachments: readonly DelegationHandoffAttachment[];
  readonly hiddenPartCount: number;
}

export interface DelegationHandoffViewDto {
  readonly delegationId: string;
  readonly projectId: string;
  readonly executionSessionId: string;
  /** unknown = 这次没扫完，不能当成「没有记录」。 */
  readonly state: 'recorded' | 'none' | 'unknown';
  readonly scanTruncated: boolean;
  readonly handoffs: readonly DelegationHandoffRecordDto[];
}

const handoffApi = {
  read: (delegationId: string) =>
    call<DelegationHandoffViewDto>(`/api/workspace-delegations/${encodeURIComponent(delegationId)}/handoff`)
};

/** 投递环节，不是执行结果。措辞刻意避开「成功 / 已处理」。 */
const TRANSPORT_LABEL: Record<DelegationHandoffTransport, string> = {
  inbox: '只进了收件箱',
  queued: '已排队，尚未送入',
  delivered: '已送入运行回合',
  held: '投递被暂停',
  failed: '投递失败',
  unknown: '投递状态未知'
};

const TRANSPORT_HINT: Partial<Record<DelegationHandoffTransport, string>> = {
  inbox: '收件箱里有这封信，但没有证据表明它进了某次运行。',
  queued: '已排队等待送入运行；排到之后才会进入回合。',
  delivered: '只表示信被交给了那次运行，不代表任务完成、测试通过或提交可用。',
  held: '被 Hub 暂停，原因见下。',
  failed: '投递没有完成，原因见下。'
};

/** 失败码 / 暂停原因来自 domain，界面只负责翻译，不额外推断。 */
const FAILURE_LABEL: Record<string, string> = {
  target_offline: '目标会话不在线',
  timeout: '等待超时',
  rate_limited: '被限流',
  context_overflow: '上下文超出上限',
  auth: '鉴权失败',
  quota: '额度不足',
  config: '配置有误',
  denied: '被拒绝',
  unresolvable: '找不到目标',
  depth_exceeded: '协作链太深',
  turn_failed: '对方这一轮失败',
  archived: '目标会话已收起',
  duplicate: '重复内容被拦下',
  busy: '对方队列已满'
};

const HOLD_LABEL: Record<string, string> = {
  pingpong: '两条会话来回次数太多',
  privilege: '从需要审批的会话发给免审批会话'
};

const failureText = (code: string): string => FAILURE_LABEL[code] ?? code;
const holdText = (code: string): string => HOLD_LABEL[code] ?? code;

/** 白名单元数据的中性文字；一律不生成 a[href]、file:// 或打开文件的动作。 */
function attachmentText(attachment: DelegationHandoffAttachment): string {
  if (attachment.kind === 'ref') {
    const branch = attachment.branch === null || attachment.branch === '' ? '分支未知' : attachment.branch;
    const sha = attachment.sha === null || attachment.sha === '' ? '提交未知' : attachment.sha;
    return `引用 ${attachment.repo} · ${branch} · ${sha}`;
  }
  if (attachment.kind === 'link') {
    const label = attachment.label === null || attachment.label.trim() === '' ? attachment.url : attachment.label;
    return `链接 ${label}（未自动打开）`;
  }
  return '文件引用（不带路径，未自动打开）';
}

function HandoffEntry({ entry }: { entry: DelegationHandoffRecordDto }) {
  return (
    <li className="rounded-control border border-hair px-2 py-1.5" data-testid="handoff-entry" data-transport={entry.transport}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-meta text-secondary" data-testid="handoff-transport">
          {TRANSPORT_LABEL[entry.transport]}
        </span>
        <span className="text-meta text-tertiary">{when(entry.sentAt)}</span>
        <span className="select-all break-all font-mono text-meta text-tertiary">{entry.messageId}</span>
      </div>
      <p className="mt-0.5 text-meta text-tertiary">{TRANSPORT_HINT[entry.transport]}</p>
      {entry.failure !== null && entry.failure.trim() !== '' ? (
        <p className="mt-0.5 break-words text-meta text-rust" data-testid="handoff-failure">
          失败原因：{failureText(entry.failure)}
        </p>
      ) : null}
      {entry.holdReason !== null && entry.holdReason.trim() !== '' ? (
        <p className="mt-0.5 break-words text-meta text-secondary" data-testid="handoff-hold-reason">
          暂停原因：{holdText(entry.holdReason)}
        </p>
      ) : null}
      {entry.deliveredAt !== null ? (
        <p className="mt-0.5 text-meta text-tertiary">送入时间 {when(entry.deliveredAt)}</p>
      ) : null}
      {entry.readAt !== null ? <p className="mt-0.5 text-meta text-tertiary">读于 {when(entry.readAt)}</p> : null}

      <p
        className="mt-1 max-h-40 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded-sm bg-surface-1 px-2 py-1 text-meta text-secondary"
        data-testid="handoff-body"
      >
        {entry.body}
      </p>
      {entry.bodyTruncated ? (
        <p className="mt-0.5 text-meta text-tertiary" data-testid="handoff-body-truncated">
          内容过长，这里只显示前一段。
        </p>
      ) : null}
      {entry.hiddenPartCount > 0 ? (
        <p className="mt-0.5 text-meta text-tertiary" data-testid="handoff-hidden-parts">
          另有 {entry.hiddenPartCount} 段未显示。
        </p>
      ) : null}

      {entry.candidate !== null ? (
        <div className="mt-1 rounded-sm border border-hair px-2 py-1" data-testid="handoff-candidate">
          <p className="text-meta text-tertiary">消息带的候选提交（只转录引用，未核验提交是否可用）</p>
          <p className="select-all break-all font-mono text-meta text-secondary">{entry.candidate.sha}</p>
          <p className="break-all text-meta text-tertiary">仓库 {entry.candidate.repoId}</p>
        </div>
      ) : null}

      {entry.attachments.length > 0 ? (
        <div className="mt-1" data-testid="handoff-attachments">
          <p className="text-meta text-tertiary">附件 {entry.attachments.length} 个（只显示元数据）</p>
          <ul className="mt-0.5 space-y-0.5">
            {entry.attachments.map((attachment, index) => (
              <li
                key={`${entry.messageId}-att-${index}`}
                className="break-all text-meta text-tertiary"
                data-testid="handoff-attachment"
                data-kind={attachment.kind}
              >
                {attachmentText(attachment)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

function HandoffSection({ record }: { record: DelegationDto }) {
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['delegation-handoff', record.id] as const,
    queryFn: () => handoffApi.read(record.id),
    staleTime: 0,
    retry: false
  });
  const view = data ?? null;
  const incomplete = view !== null && (view.state === 'unknown' || view.scanTruncated);

  return (
    <div data-testid="delegation-handoff" data-state={view?.state ?? 'loading'}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-meta text-tertiary">转交给执行会话的记录</p>
        <button
          type="button"
          className="shrink-0 rounded-sm px-1 text-meta text-tertiary hover:text-primary"
          onClick={() => void refetch()}
          data-testid="handoff-reload"
        >
          刷新
        </button>
      </div>

      {isPending && view === null ? <p className="mt-1 text-meta text-tertiary">正在读转交记录…</p> : null}

      {error !== null ? (
        <p role="alert" className="mt-1 break-words text-meta text-rust" data-testid="handoff-error">
          {error instanceof Error ? error.message : '转交记录暂时读不到'}
        </p>
      ) : null}

      {view !== null ? (
        <>
          {view.state === 'unknown' ? (
            <p className="mt-1 text-meta text-rust" data-testid="handoff-unknown">
              这次扫描没有完成，不能据此断定没有转交记录。
            </p>
          ) : null}
          {view.state === 'none' ? (
            <p className="mt-1 text-meta text-tertiary" data-testid="handoff-empty">
              没有找到转交给这个执行会话的信件记录。
            </p>
          ) : null}
          {incomplete && view.state !== 'none' ? (
            <p className="mt-1 text-meta text-secondary" data-testid="handoff-truncated">
              扫描到上限，可能还有更早的记录没有列出。
            </p>
          ) : null}
          {view.handoffs.length > 0 ? (
            <ol className="mt-1 max-h-60 space-y-1 overflow-y-auto overscroll-contain">
              {view.handoffs.map((entry) => (
                <HandoffEntry key={entry.messageId} entry={entry} />
              ))}
            </ol>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
