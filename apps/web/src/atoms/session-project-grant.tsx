import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PROJECT_TOOL_GRANT_SCOPES,
  PROJECT_TOOL_SCOPES,
  projectToolGrantApi,
  type ProjectToolGrantView,
  type ProjectToolScope
} from '../shell/api.ts';
import { sessionKeys } from '../shell/query-keys.ts';

type GrantScope = (typeof PROJECT_TOOL_GRANT_SCOPES)[number];

/** 某一行的临时反馈：正在存 / 存好了（记着朝哪个方向）/ 没存成（重试要用同一个方向）。 */
type RowNote =
  | { readonly kind: 'saved'; readonly wanted: boolean }
  | { readonly kind: 'failed'; readonly wanted: boolean; readonly message: string };

/**
 * 会话详情 · 项目能力（docs/design/project-session-mcp.md §25-35）。
 *
 * 普通会话默认只能在**自己的任务**里做事；要在项目里直接看会话、建任务、开 worktree、发交接、导入候选
 * 或改资产，必须由会话归属人在网页上逐项打开。这里就是那张授权表：
 *
 * - 默认全关；每次勾选立刻写回，不是「先改后保存」的表单。
 * - 只改授权记录：正在跑的会话进程不会凭空多出工具，要重新托管才按新清单启动。
 * - 撤销对**已经发出的旧工具令牌**同样有效：工具入口每次调用都会重读当前授权。
 *
 * 写回是串行的（一次 PUT 带完整并集，最后一项走 DELETE），所以哪一行在写、写没写成，
 * 就显示在那一行下面：底下再挂一条全局提示，手机上永远在视口外。
 *
 * 手机首屏放不下所有开关：整段收成一行摘要（标题 + 服务端已确认的状态），桌面默认展开。
 * 摘要不跟着乐观值走，正在写的时候另加「保存中」。
 */
export function SessionProjectGrant({ sessionId }: { sessionId: string }) {
  const client = useQueryClient();
  const key = sessionKeys.projectGrant(sessionId);
  const view = useQuery({
    queryKey: key,
    queryFn: () => projectToolGrantApi.view(sessionId),
    staleTime: 15_000,
    retry: false
  });

  /** 乐观的授权项；请求落定后交还给查询缓存。 */
  const [override, setOverride] = useState<readonly ProjectToolScope[] | null>(null);
  const [saving, setSaving] = useState<GrantScope | 'all' | null>(null);
  const [rowNotes, setRowNotes] = useState<Partial<Record<GrantScope, RowNote>>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<'saved' | 'revoked' | null>(null);
  const [revokeArmed, setRevokeArmed] = useState(false);
  /** 手机上收成一行摘要，桌面直接摊开。 */
  const [open, setOpen] = useState(desktopExpanded);
  /** 在途请求的轮次。下次读写或切会话都会换轮，旧回包不能解锁、不能落地。 */
  const inFlight = useRef<number | null>(null);
  /** 会话切换会让在途请求作废：回包只认自己那一轮。 */
  const seq = useRef(0);

  // 检查器里切了会话：上一条会话的乐观状态、确认框和行内反馈都不能带过去。
  useEffect(() => {
    seq.current += 1;
    inFlight.current = null;
    setOverride(null);
    setSaving(null);
    setRowNotes({});
    setError(null);
    setSaved(null);
    setRevokeArmed(false);
  }, [sessionId]);

  const scopes = override ?? view.data?.scopes ?? [];
  const locked = saving !== null;

  /** 用完整 scope 列表排序；这次不动的那几项原样保留，不会被一次勾选顺手撤掉。 */
  const withScope = (scope: GrantScope, on: boolean): readonly ProjectToolScope[] =>
    PROJECT_TOOL_SCOPES.filter((candidate) => (candidate === scope ? on : scopes.includes(candidate)));

  const commit = async (next: readonly ProjectToolScope[], target: GrantScope | 'all', wanted: boolean) => {
    if (inFlight.current !== null) return;
    const token = ++seq.current;
    inFlight.current = token;
    setOverride(next);
    setSaving(target);
    setError(null);
    setSaved(null);
    setRevokeArmed(false);
    if (target !== 'all') setRowNotes((old) => ({ ...old, [target]: undefined }));
    try {
      // 服务端不接受空的 scopes：关掉最后一项就是撤销整条记录。
      const updated: ProjectToolGrantView =
        next.length === 0
          ? await projectToolGrantApi.revoke(sessionId)
          : await projectToolGrantApi.set(sessionId, next);
      if (token !== seq.current) return;
      client.setQueryData<ProjectToolGrantView>(key, (previous) => ({
        ...updated,
        repositoryReadAvailable: updated.repositoryReadAvailable ?? previous?.repositoryReadAvailable
      }));
      void client.invalidateQueries({ queryKey: key });
      setOverride(null);
      setSaved(next.length === 0 ? 'revoked' : 'saved');
      if (target !== 'all') setRowNotes((old) => ({ ...old, [target]: { kind: 'saved', wanted } }));
    } catch (failure) {
      if (token !== seq.current) return;
      setOverride(null);
      const message =
        failure instanceof Error && failure.message !== '' ? failure.message : '没保存成，过一会儿再试';
      if (target === 'all') setError(message);
      else setRowNotes((old) => ({ ...old, [target]: { kind: 'failed', wanted, message } }));
    } finally {
      // 只放掉自己那一轮：切会话后旧回包回来了，不能把新会话正在写的闸门打开。
      if (inFlight.current === token) inFlight.current = null;
      if (token === seq.current) setSaving(null);
    }
  };

  const toggle = (scope: GrantScope, on: boolean) => {
    void commit(withScope(scope, on), scope, on);
  };

  const retry = (scope: GrantScope) => {
    const wanted = rowNotes[scope]?.wanted ?? false;
    // 重试用当前服务端状态重新算并集：期间别的行可能已经存成功过。
    void commit(withScope(scope, wanted), scope, wanted);
  };

  if (view.isLoading) {
    return (
      <section data-testid="project-grant" className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <p className="shrink-0 text-meta text-secondary">项目能力</p>
          <p className="min-w-0 flex-1 truncate text-right font-mono text-meta text-tertiary" data-testid="project-grant-summary">
            读取中…
          </p>
        </div>
      </section>
    );
  }
  // 不把过期缓存当成当前可用性：重新查询失权或失败时收起开关。
  if (view.error !== null) {
    return (
      <section data-testid="project-grant" className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <p className="shrink-0 text-meta text-secondary">项目能力</p>
          <p className="min-w-0 flex-1 truncate text-right font-mono text-meta text-tertiary" data-testid="project-grant-summary">
            读不到
          </p>
        </div>
        <p className="mt-0.5 text-meta leading-[1.55] text-tertiary" data-testid="project-grant-unavailable">
          读不到这条会话的项目授权。只有会话归属人能在网页上管理它。
        </p>
      </section>
    );
  }

  // 摘要只报服务端确认过的那份；正在写的时候另加「保存中」，不把乐观值说成已生效。
  const confirmed = view.data?.scopes ?? [];
  const opened = PROJECT_TOOL_GRANT_SCOPES.filter((scope) => confirmed.includes(scope));
  const confirmedText = opened.length === 0 ? '默认全关' : `${opened.length} 项已开`;
  const summaryText = saving === null ? confirmedText : `${confirmedText} · 保存中…`;

  return (
    <details
      data-testid="project-grant"
      aria-labelledby={`project-grant-title-${sessionId}`}
      className="group/grant min-w-0"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 md:min-h-0">
        <span aria-hidden className="inline-block w-2.5 shrink-0 text-center text-tertiary transition-transform group-open/grant:rotate-90">
          ›
        </span>
        <span id={`project-grant-title-${sessionId}`} className="shrink-0 text-meta text-secondary">
          项目能力
        </span>
        <span
          className="min-w-0 flex-1 truncate text-right font-mono text-meta text-tertiary"
          data-testid="project-grant-summary"
          title={opened.length === 0 ? '默认全关' : opened.join('、')}
        >
          {summaryText}
        </span>
      </summary>
      <div className="mt-1 min-w-0">
        <p className="text-meta leading-[1.55] text-tertiary">
          由你（会话归属人）逐项开启，默认全关；每一项互相独立，只开需要的那几项。
        </p>

        <ul className="mt-1.5 divide-y divide-hair border-y border-hair">
          {PROJECT_TOOL_GRANT_SCOPES.filter((scope) => scope !== 'repo:read' || view.data?.repositoryReadAvailable === true || confirmed.includes(scope)).map((scope) => (
            <Fragment key={scope}>
              {GROUP_LABEL[scope] ? (
                <li aria-hidden className="pt-1.5 pb-0.5 text-meta text-tertiary">
                  {GROUP_LABEL[scope]}
                </li>
              ) : null}
              {scope === 'repo:read' && view.data?.repositoryReadAvailable !== true ? (
                <li className="pt-1.5 text-meta text-tertiary">当前仓库读取能力不可用，可关闭已有授权。</li>
              ) : null}
              <GrantRow
                scope={scope}
                enabled={scopes.includes(scope)}
                saving={saving === scope}
                locked={locked || (scope === 'repo:read' && view.data?.repositoryReadAvailable !== true && !scopes.includes(scope))}
                note={rowNotes[scope]}
                onToggle={(on) => toggle(scope, on)}
                onRetry={() => retry(scope)}
              />
            </Fragment>
          ))}
        </ul>

        {scopes.length === 0 ? (
          <p className="mt-1.5 text-meta text-tertiary" data-testid="project-grant-empty">
            现在没有开启任何项目能力。
          </p>
        ) : (
          <>
            <p className="mt-1.5 text-meta leading-[1.55] text-tertiary" data-testid="project-grant-runtime-note">
              新开或重新托管的会话进程才会拿到这些工具；正在跑的进程仍按启动时的清单。
            </p>
            <div className="mt-2 border-t border-hair pt-2">
              <p className="text-meta leading-[1.55] text-tertiary" data-testid="project-grant-revoke-note">
                撤销立即生效：即使会话进程还拿着之前的工具授权，下一次调用也会被拒绝。
              </p>
              {!revokeArmed ? (
                <button
                  type="button"
                  data-testid="project-grant-revoke"
                  className="mt-1.5 min-h-9 rounded-sm border border-rust px-2 text-meta text-rust hover:bg-rust/10"
                  onClick={() => {
                    setRevokeArmed(true);
                    setSaved(null);
                  }}
                  disabled={locked}
                >
                  撤销全部项目授权
                </button>
              ) : (
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="project-grant-revoke-confirm"
                    className="min-h-9 rounded-sm bg-rust px-2.5 text-meta text-canvas hover:opacity-90 disabled:opacity-50"
                    onClick={() => void commit([], 'all', false)}
                    disabled={locked}
                  >
                    {saving === 'all' ? '撤销中…' : '确认撤销'}
                  </button>
                  <button
                    type="button"
                    data-testid="project-grant-revoke-cancel"
                    className="min-h-9 rounded-sm border border-hair px-2.5 text-meta text-secondary hover:text-primary disabled:opacity-50"
                    onClick={() => setRevokeArmed(false)}
                    disabled={locked}
                  >
                    取消
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* 撤销的结果留在这一行；普通保存的行内已经写过了，这里只留给读屏。 */}
        <p
          role="status"
          aria-live="polite"
          data-testid="project-grant-status"
          className={saved === 'revoked' ? 'mt-1.5 text-meta text-rust' : 'sr-only'}
        >
          {saving === 'all'
            ? '撤销中…'
            : saved === 'revoked'
              ? '已撤销。旧令牌也不能再用。'
              : saved === 'saved'
                ? '已保存。'
                : ''}
        </p>
        {error !== null ? (
          <p role="alert" data-testid="project-grant-error" className="mt-1.5 text-meta text-rust">
            {error}
          </p>
        ) : null}
        <p className="mt-1.5 text-meta leading-[1.55] text-tertiary" data-testid="project-grant-footnote">
          提示词和工具输出不能自己打开这些能力；权限只由会话归属人在网页上给。
        </p>
        {view.data && view.data.scopes.length > 0 ? (
          <details className="group/scopes mt-1" data-testid="project-grant-scopes">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-meta text-tertiary hover:text-secondary">
              <span aria-hidden className="inline-block w-2.5 text-center transition-transform group-open/scopes:rotate-90">
                ›
              </span>
              授权项 ID
            </summary>
            <ul className="mt-0.5 pl-3.5 font-mono text-meta leading-[1.6] text-tertiary">
              {view.data.scopes.map((scope) => (
                <li key={scope}>{scope}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </details>
  );
}

/** 抽屉/停靠面板共用这棵树：宽屏默认摊开，手机上默认收成一行摘要。 */
function desktopExpanded(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;
}

/** 前五项是日常协作；资产写会产出待审批的修订，单独隔开。 */
const GROUP_LABEL: Partial<Record<GrantScope, string>> = { 'asset:write': '进阶 · 会创建审批' };

const SCOPE_COPY: Readonly<Record<GrantScope, { readonly label: string; readonly hint: string }>> = {
  'project:read': {
    label: '查看项目会话',
    hint: '列出这个项目里你能看到的会话，用来选择交接对象'
  },
  'task:write': {
    label: '建任务',
    hint: '在项目里新建任务、给新任务设父任务'
  },
  'worktree:open': {
    label: '开 worktree 会话',
    hint: '为任务在独立目录里开执行会话，主目录不动'
  },
  'message:send': {
    label: '发交接消息',
    hint: '默认只投递收件箱，不自动唤醒；也不替对方切分支或开工'
  },
  'candidate:import': {
    label: '导入候选提交',
    hint: '同 Worker、同仓库的完整 SHA 只写入专用引用；不切目录、不推送，和发消息是两件事'
  },
  'asset:write': {
    label: '改项目资产',
    hint: '可提交新的或修订的项目自有资产等待审批，并按角色管理未来会话的资产启用；不直接发布、不改上游共享资产、不影响运行中的会话'
  },
  'repo:read': {
    label: '读取项目仓库',
    hint: '读取获准仓库的远端快照，不更新本地文件，也不授予推送权限'
  }
};

function GrantRow({
  scope,
  enabled,
  saving,
  locked,
  note,
  onToggle,
  onRetry
}: {
  readonly scope: GrantScope;
  readonly enabled: boolean;
  readonly saving: boolean;
  readonly locked: boolean;
  readonly note: RowNote | undefined;
  readonly onToggle: (on: boolean) => void;
  readonly onRetry: () => void;
}) {
  const copy = SCOPE_COPY[scope];
  const state = saving ? 'saving' : note === undefined ? 'idle' : note.kind;
  return (
    <li
      data-testid="project-grant-row"
      data-scope={scope}
      data-enabled={enabled ? 'true' : 'false'}
      data-row-state={state}
      className="min-w-0"
    >
      <label className="flex min-h-11 cursor-pointer items-start gap-2 py-1.5">
        <input
          type="checkbox"
          role="switch"
          data-testid="project-grant-toggle"
          name={copy.label}
          aria-label={`${copy.label}（${scope}）`}
          aria-describedby={`project-grant-hint-${scope}`}
          checked={enabled}
          disabled={locked}
          onChange={(event) => onToggle(event.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-ring)] disabled:cursor-default disabled:opacity-40"
        />
        <span className="min-w-0 flex-1">
          <span className="text-meta text-primary">{copy.label}</span>
          <span id={`project-grant-hint-${scope}`} className="mt-0.5 block text-meta leading-[1.45] text-tertiary">
            {copy.hint}
          </span>
        </span>
      </label>
      {saving ? (
        <p className="pb-1.5 pl-6 text-meta text-tertiary" data-testid="project-grant-row-status">
          保存中…
        </p>
      ) : note?.kind === 'saved' ? (
        <p className="pb-1.5 pl-6 text-meta text-tertiary" data-testid="project-grant-row-status">
          {note.wanted ? '已保存 · 重新托管后生效' : '已关闭 · 下次调用就拒绝'}
        </p>
      ) : note?.kind === 'failed' ? (
        <p
          role="alert"
          className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 pb-1.5 pl-6 text-meta text-rust"
          data-testid="project-grant-row-status"
        >
          <span className="min-w-0">
            {note.wanted ? '没开成' : '没关成'}：{note.message}
          </span>
          <button
            type="button"
            data-testid="project-grant-row-retry"
            className="shrink-0 underline decoration-dotted underline-offset-2 hover:text-primary disabled:opacity-50"
            onClick={onRetry}
            disabled={locked}
          >
            再试一次
          </button>
        </p>
      ) : null}
    </li>
  );
}
