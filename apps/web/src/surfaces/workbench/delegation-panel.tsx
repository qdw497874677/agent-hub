import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { delegationsApi, type DelegationDto } from '../../shell/api.ts';
import { useDelegations } from '../../shell/delegations.ts';
import { delegationKeys } from '../../shell/query-keys.ts';
import {
  DELEGATION_STATE_LABEL,
  delegationCanConfirm,
  delegationStartupLabel,
  delegationStatusLine,
  delegationTone,
  shortSha
} from '../../atoms/delegation.ts';
import { DelegationPublishDialog } from './publish-dialog.tsx';

const TONE_CLASS: Record<ReturnType<typeof delegationTone>, string> = {
  ok: 'text-sage',
  warn: 'text-secondary',
  danger: 'text-rust',
  idle: 'text-tertiary'
};

function StateBadge({ record }: { record: DelegationDto }) {
  return (
    <span
      className={`shrink-0 rounded-sm border border-hair px-1.5 py-0.5 font-mono text-meta ${TONE_CLASS[delegationTone(record.state)]}`}
      data-testid="delegation-state"
      data-state={record.state}
    >
      {DELEGATION_STATE_LABEL[record.state]}
    </span>
  );
}

/**
 * 主会话里的派工列表。
 *
 * 只做三件事：显示服务端记下的状态与参数、确认 Runtime 提好的那一条、进执行会话 / 复核发布。
 * 不轮询、不本地推算状态：刷新是显式动作。
 */
export function DelegationPanel({
  coordinatorSessionId,
  tasks,
  onOpenSession,
  onStart
}: {
  coordinatorSessionId: string;
  /** 项目里的任务，只用来把 taskId 翻成名字。 */
  tasks: readonly { readonly id: string; readonly title: string }[];
  onOpenSession: (sessionId: string) => void;
  onStart: () => void;
}) {
  const client = useQueryClient();
  const { rows, loading, error, reload } = useDelegations(coordinatorSessionId);
  const [publishing, setPublishing] = useState<DelegationDto | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const confirm = async (record: DelegationDto) => {
    setConfirming(record.id);
    setConfirmError(null);
    try {
      // 只发包住这条提议的 id：目标、仓库、基线、说明、配置都按服务端存的那条来。
      await delegationsApi.confirm(coordinatorSessionId, record.id);
      await client.invalidateQueries({ queryKey: delegationKeys.forCoordinator(coordinatorSessionId) });
    } catch (cause) {
      setConfirmError(cause instanceof Error ? cause.message : '确认失败');
    } finally {
      setConfirming(null);
    }
  };

  const titleOf = (taskId: string) => tasks.find((task) => task.id === taskId)?.title ?? null;

  return (
    <section
      className="shrink-0 border-b border-hair px-2 py-2 md:px-3"
      aria-label="派工"
      data-testid="delegation-panel"
    >
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-meta text-tertiary">
          派工{rows.length > 0 ? ` · ${rows.length} 条` : ''}
        </p>
        <button
          type="button"
          className="rounded-sm px-1.5 text-meta text-tertiary hover:text-primary"
          onClick={reload}
          data-testid="delegation-reload"
        >
          刷新
        </button>
        <button
          type="button"
          className="min-h-9 rounded-control border border-hair px-2 text-meta text-secondary hover:border-strong hover:text-primary"
          onClick={onStart}
          data-testid="delegation-start"
        >
          派工到任务…
        </button>
      </div>

      {error !== null ? (
        <p role="alert" className="mt-1 text-meta text-rust" data-testid="delegation-error">
          {error}
        </p>
      ) : null}
      {confirmError !== null ? (
        <p role="alert" className="mt-1 text-meta text-rust" data-testid="delegation-confirm-error">
          {confirmError}
        </p>
      ) : null}

      {loading ? <p className="mt-1 text-meta text-tertiary">正在读派工记录…</p> : null}
      {!loading && error === null && rows.length === 0 ? (
        <p className="mt-1 text-meta text-tertiary" data-testid="delegation-empty">
          还没有派工。派工时由你选任务、仓库和基线，执行会话在自己的独立目录里跑。
        </p>
      ) : null}

      <ul className="mt-1 space-y-1.5">
        {rows.map((record) => (
          <li
            key={record.id}
            className="rounded-control border border-hair px-2 py-1.5"
            data-testid="delegation-row"
            data-delegation-id={record.id}
            data-state={record.state}
            data-can-confirm={record.canConfirm === true ? 'true' : 'false'}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <StateBadge record={record} />
              <span className="min-w-0 flex-1 truncate text-sub text-primary" data-testid="delegation-task">
                {titleOf(record.taskId) ?? record.taskId}
              </span>
              <span className="shrink-0 font-mono text-meta text-tertiary" title={record.branch}>
                {record.branch}
              </span>
            </div>
            <p className="mt-0.5 text-meta text-secondary" data-testid="delegation-status">
              {delegationStatusLine(record)}
            </p>
            <p className="mt-0.5 text-meta text-tertiary" data-testid="delegation-meta">
              基线 {record.baseBranch}
              {record.baseSha ? ` @ ${shortSha(record.baseSha)}` : ''} · {delegationStartupLabel(record.startup)}
            </p>
            <p className="mt-0.5 line-clamp-2 text-meta text-secondary" data-testid="delegation-instructions">
              {record.instructions}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {delegationCanConfirm(record) ? (
                <button
                  type="button"
                  className="min-h-9 rounded-control bg-action px-2.5 text-meta font-medium text-action-fg hover:bg-action/90 disabled:opacity-40"
                  disabled={confirming === record.id}
                  onClick={() => void confirm(record)}
                  data-testid="delegation-confirm"
                  data-delegation-id={record.id}
                >
                  {confirming === record.id ? '正在确认…' : '确认开始'}
                </button>
              ) : null}
              <button
                type="button"
                className="min-h-9 rounded-control border border-hair px-2 text-meta text-secondary hover:border-strong hover:text-primary"
                onClick={() => onOpenSession(record.executionSessionId)}
                data-testid="delegation-open"
                data-delegation-id={record.id}
              >
                进执行会话
              </button>
              <button
                type="button"
                className="min-h-9 rounded-control border border-hair px-2 text-meta text-secondary hover:border-strong hover:text-primary"
                onClick={() => setPublishing(record)}
                data-testid="delegation-publish-open"
                data-delegation-id={record.id}
              >
                复核发布…
              </button>
            </div>
          </li>
        ))}
      </ul>

      {publishing !== null ? (
        <DelegationPublishDialog
          record={publishing}
          onClose={() => setPublishing(null)}
          onPublished={() => {
            void client.invalidateQueries({ queryKey: delegationKeys.forCoordinator(coordinatorSessionId) });
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * 执行会话上的来路横幅。
 *
 * 只在能从主会话派工记录里证明这条会话是某条派工的执行会话时才出现——
 * 别的临时目录会话（换个地方继续、隔离目录）可能有相似形状，不能凭目录猜。
 */
export function DelegationOriginBanner({
  record,
  taskTitle,
  onBack
}: {
  record: DelegationDto;
  taskTitle: string | null;
  onBack: () => void;
}) {
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hair px-2 py-1.5 text-meta md:px-3"
      data-testid="delegation-origin"
      data-delegation-id={record.id}
    >
      <span className="rounded bg-card px-1.5 py-0.5 text-meta text-tertiary">派工</span>
      <span className="min-w-0 flex-1 truncate text-secondary">
        主会话派给「{taskTitle ?? record.taskId}」的执行会话 · 基线 {record.baseBranch}
        {record.baseSha ? ` @ ${shortSha(record.baseSha)}` : ''}
      </span>
      <button type="button" className="shrink-0 text-link" onClick={onBack}>
        回到主会话
      </button>
    </div>
  );
}
