import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PROJECT_TOOL_GRANT_SCOPES,
  PROJECT_TOOL_SCOPES,
  projectToolGrantApi,
  type ProjectToolGrantView,
  type ProjectToolScope
} from '../shell/api.ts';
import { sessionKeys } from '../shell/query-keys.ts';

/**
 * 会话详情 · 项目能力（docs/design/project-session-mcp.md §25-35）。
 *
 * 普通会话默认只能在**自己的任务**里做事；要在项目里直接看会话、建任务、开 worktree、发交接、导入候选
 * 或改资产，必须由会话归属人在网页上逐项打开。这里就是那张授权表：
 *
 * - 默认全关；每次勾选立刻写回，不是「先改后保存」的表单。
 * - 只改授权记录：正在跑的会话进程不会凭空多出工具，要重新托管才按新清单启动。
 * - 撤销对**已经发出的旧工具令牌**同样有效：工具入口每次调用都会重读当前授权。
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<'saved' | 'revoked' | null>(null);
  const [revokeArmed, setRevokeArmed] = useState(false);

  // 检查器里切了会话：上一条会话的乐观状态和确认框不能带过去。
  useEffect(() => {
    setOverride(null);
    setSaving(false);
    setError(null);
    setSaved(null);
    setRevokeArmed(false);
  }, [sessionId]);

  const scopes = override ?? view.data?.scopes ?? [];
  const locked = saving || view.isPending;

  const commit = async (next: readonly ProjectToolScope[]) => {
    setOverride(next);
    setSaving(true);
    setError(null);
    setSaved(null);
    setRevokeArmed(false);
    try {
      const updated: ProjectToolGrantView =
        next.length === 0
          ? await projectToolGrantApi.revoke(sessionId)
          : await projectToolGrantApi.set(sessionId, next);
      client.setQueryData<ProjectToolGrantView>(key, updated);
      setOverride(null);
      setSaved(next.length === 0 ? 'revoked' : 'saved');
    } catch (failure) {
      setOverride(null);
      setError(failure instanceof Error && failure.message !== '' ? failure.message : '没保存成，过一会儿再试');
    } finally {
      setSaving(false);
    }
  };

  const toggle = (scope: ProjectToolScope, on: boolean) => {
    // 用完整 scope 列表排序；这次不动的那几项原样保留，不会被一次勾选顺手撤掉。
    // 关掉最后一项时 next 为空，commit 会走 DELETE 撤销整条记录——服务端不接受空的 PUT。
    const next = PROJECT_TOOL_SCOPES.filter((candidate) =>
      candidate === scope ? on : scopes.includes(candidate)
    );
    void commit(next);
  };

  if (view.isLoading) return null;
  if (view.error !== null && view.data === undefined) {
    return (
      <section data-testid="project-grant" className="min-w-0">
        <p className="mb-0.5 text-meta text-tertiary">项目能力</p>
        <p className="text-meta leading-[1.45] text-tertiary" data-testid="project-grant-unavailable">
          读不到这条会话的项目授权。只有会话归属人能在网页上管理它。
        </p>
      </section>
    );
  }

  return (
    <section
      data-testid="project-grant"
      aria-labelledby={`project-grant-title-${sessionId}`}
      className="min-w-0"
    >
      <p id={`project-grant-title-${sessionId}`} className="mb-0.5 text-meta text-tertiary">
        项目能力
      </p>
      <p className="text-meta leading-[1.45] text-tertiary">
        由你（会话归属人）逐项开启，默认全关；每一项互相独立，只开需要的那几项。提示词和工具输出不能自己打开。
      </p>

      <fieldset className="mt-2 min-w-0" disabled={locked}>
        <legend className="sr-only">项目能力授权</legend>
        <ul className="divide-y divide-hair border-y border-hair">
          {PROJECT_TOOL_GRANT_SCOPES.map((scope) => (
            <GrantRow
              key={scope}
              scope={scope}
              enabled={scopes.includes(scope)}
              saving={saving}
              onToggle={(on) => toggle(scope, on)}
            />
          ))}
        </ul>
      </fieldset>

      {scopes.length === 0 ? (
        <p className="mt-1.5 text-meta text-tertiary" data-testid="project-grant-empty">
          现在没有开启任何项目能力。
        </p>
      ) : (
        <>
          <p className="mt-1.5 text-meta leading-[1.45] text-tertiary" data-testid="project-grant-runtime-note">
            新开或重新托管的会话进程才会拿到这些工具；正在跑的进程仍按启动时的清单。
          </p>
          <div className="mt-2 border-t border-hair pt-2">
            <p className="text-meta leading-[1.45] text-tertiary" data-testid="project-grant-revoke-note">
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
                disabled={saving}
              >
                撤销全部项目授权
              </button>
            ) : (
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="project-grant-revoke-confirm"
                  className="min-h-9 rounded-sm bg-rust px-2.5 text-meta text-canvas hover:opacity-90 disabled:opacity-50"
                  onClick={() => void commit([])}
                  disabled={saving}
                >
                  {saving ? '撤销中…' : '确认撤销'}
                </button>
                <button
                  type="button"
                  data-testid="project-grant-revoke-cancel"
                  className="min-h-9 rounded-sm border border-hair px-2.5 text-meta text-secondary hover:text-primary disabled:opacity-50"
                  onClick={() => setRevokeArmed(false)}
                  disabled={saving}
                >
                  取消
                </button>
              </div>
            )}
          </div>
        </>
      )}

      <p
        role="status"
        aria-live="polite"
        data-testid="project-grant-status"
        className={`mt-1.5 min-h-[1em] text-meta ${saved === 'revoked' ? 'text-rust' : 'text-sage'}`}
      >
        {saving
          ? '保存中…'
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
    </section>
  );
}

const SCOPE_COPY: Readonly<
  Record<(typeof PROJECT_TOOL_GRANT_SCOPES)[number], { readonly label: string; readonly hint: string }>
> = {
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
  }
};

function GrantRow({
  scope,
  enabled,
  saving,
  onToggle
}: {
  readonly scope: (typeof PROJECT_TOOL_GRANT_SCOPES)[number];
  readonly enabled: boolean;
  readonly saving: boolean;
  readonly onToggle: (on: boolean) => void;
}) {
  const copy = SCOPE_COPY[scope];
  return (
    <li
      data-testid="project-grant-row"
      data-scope={scope}
      data-enabled={enabled ? 'true' : 'false'}
      className="min-w-0"
    >
      <label
        className={`flex min-h-11 cursor-pointer items-start gap-2 py-1.5 transition-opacity ${saving ? 'opacity-60' : ''}`}
      >
        <input
          type="checkbox"
          role="switch"
          data-testid="project-grant-toggle"
          name={copy.label}
          aria-label={`${copy.label}（${scope}）`}
          aria-describedby={`project-grant-hint-${scope}`}
          checked={enabled}
          disabled={saving}
          onChange={(event) => onToggle(event.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-ring)] disabled:cursor-default"
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span className="text-meta text-primary">{copy.label}</span>
            <span className="font-mono text-[10px] text-tertiary">{scope}</span>
          </span>
          <span id={`project-grant-hint-${scope}`} className="mt-0.5 block text-meta leading-[1.45] text-tertiary">
            {copy.hint}
          </span>
        </span>
      </label>
    </li>
  );
}
