import { useQuery } from '@tanstack/react-query';
import { adminApi } from '../api.ts';
import type { AdminWorkerDto } from '../api.ts';
import { HarnessBadges, RecheckButton } from '../harness.tsx';
import { SMALL, DANGER, at, errorText, Section, Panel, Empty, useAdminAction } from './shared.tsx';

const UPDATE_TEXT: Record<string, string> = {
  updating: '更新中',
  succeeded: '更新成功',
  failed: '更新失败',
  refused: '拒绝更新',
  rolled_back: '已回退'
};

const shortCommit = (commit: string | null | undefined): string => (commit ? commit.slice(0, 7) : '无提交号');
const buildText = (build: AdminWorkerDto['build']): string =>
  build ? `v${build.version} · ${shortCommit(build.commit)}` : '版本未知（旧版 Worker）';

export function Workers() {
  const workers = useQuery({
    queryKey: ['admin', 'workers'],
    queryFn: adminApi.workers,
    // 有机器在更新时快一点刷新，进度才跟得上
    refetchInterval: (query) =>
      query.state.data?.workers.some((worker) => worker.update?.state === 'updating') ? 2_000 : 10_000
  });
  const action = useAdminAction(
    ({ kind, worker }: { kind: 'disconnect' | 'update' | 'revoke'; worker: AdminWorkerDto }): Promise<unknown> =>
      kind === 'update'
        ? adminApi.updateWorker(worker.workerId)
        : kind === 'revoke'
          ? adminApi.revokeWorker(worker.workerId)
          : adminApi.disconnect(worker.workerId)
  );
  const updateAll = useAdminAction(() => adminApi.updateOutdated());
  const list = workers.data?.workers ?? [];
  const hub = workers.data?.hub;
  const outdatedOnline = list.filter((worker) => worker.outdated && worker.state === 'online');
  const error = action.error ?? updateAll.error;
  return (
    <Section title="机器" aside={<span className="text-meta text-tertiary">{list.length} 台</span>}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span data-testid="hub-version" className="text-meta text-tertiary">
          hub {hub ? buildText(hub) : '…'}
        </span>
        <span className="flex-1" />
        <button
          className={SMALL}
          disabled={updateAll.isPending || outdatedOnline.length === 0}
          onClick={() => {
            if (window.confirm(`把 ${outdatedOnline.length} 台过期的在线机器更新到 hub 的版本？`))
              updateAll.mutate(undefined);
          }}
        >
          更新全部过期{outdatedOnline.length ? `（${outdatedOnline.length}）` : ''}
        </button>
      </div>
      {error ? (
        <p role="alert" className="mb-2 text-meta text-rust">
          {errorText(error)}
        </p>
      ) : null}
      <Panel>
        {list.length ? (
          <ul>
            {list.map((worker) => {
              const online = worker.state === 'online';
              const updating = worker.update?.state === 'updating';
              return (
                <li
                  key={worker.workerId}
                  data-testid="admin-worker"
                  className="border-b border-hair px-3 py-2.5 last:border-b-0"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${online ? 'bg-accent' : 'bg-card-raised border border-strong'}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-body text-primary">{worker.label}</span>
                    {worker.outdated ? (
                      <span
                        data-testid="worker-outdated"
                        className="rounded border border-rust px-1.5 text-meta text-rust"
                      >
                        过期
                      </span>
                    ) : null}
                    {online ? (
                      <button
                        className={SMALL}
                        disabled={action.isPending || updating}
                        title={worker.outdated ? '更新到 hub 的版本' : '已是最新：只做一次演练，不会重启'}
                        onClick={() => action.mutate({ kind: 'update', worker })}
                      >
                        {updating ? '更新中…' : '更新'}
                      </button>
                    ) : null}
                    {online && worker.origin === 'remote' ? (
                      <button
                        className={DANGER}
                        disabled={action.isPending}
                        onClick={() => {
                          if (window.confirm(`断开「${worker.label}」？它不会自动重连，要在那台机器上重启 Worker。`))
                            action.mutate({ kind: 'disconnect', worker });
                        }}
                      >
                        断开
                      </button>
                    ) : null}
                    {worker.origin === 'remote' ? (
                      <button
                        className={DANGER}
                        disabled={action.isPending}
                        title="作废这台机器的凭据并断开；要重新「添加机器」才能回来"
                        onClick={() => {
                          if (window.confirm(`吊销「${worker.label}」？它会立刻断开，凭据作废，要重新添加才能回来。`))
                            action.mutate({ kind: 'revoke', worker });
                        }}
                      >
                        吊销
                      </button>
                    ) : null}
                  </div>
                  <p className="pl-4 text-meta text-tertiary">
                    {online
                      ? `在线 · ${worker.sessionCount} 条会话`
                      : `离线${worker.reason ? `（${worker.reason}）` : ''}`}{' '}
                    · 最近 {at(worker.lastSeenAt)}
                  </p>
                  <p className="truncate pl-4 text-meta text-tertiary">
                    {[worker.hostname, worker.platform].filter(Boolean).join(' · ') || worker.workerId} ·{' '}
                    {worker.enrolledBy}
                  </p>
 {online && worker.harnesses.length > 0 ? (
                    <div data-testid="worker-harnesses" className="flex flex-wrap items-center gap-1.5 pl-4 pt-0.5">
                      <HarnessBadges harnesses={worker.harnesses} />
                      <RecheckButton workerId={worker.workerId} />
                    </div>
                  ) : null}
                  <p data-testid="worker-version" className="truncate pl-4 text-meta text-tertiary">
                    {buildText(worker.build)}
                  </p>
                  {worker.update ? (
                    <div data-testid="worker-update" className="pl-4 text-meta">
                      <span
                        className={
                          worker.update.state === 'failed' ||
                          worker.update.state === 'refused' ||
                          worker.update.state === 'rolled_back'
                            ? 'text-rust'
                            : 'text-secondary'
                        }
                      >
                        {UPDATE_TEXT[worker.update.state] ?? worker.update.state}：{worker.update.message} ·{' '}
                        {at(worker.update.at)}
                      </span>
                      {worker.update.logTail ? (
                        <details>
                          <summary className="cursor-pointer text-tertiary">日志</summary>
                          <pre className="mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap rounded bg-card-raised p-2 text-tertiary">
                            {worker.update.logTail}
                          </pre>
                        </details>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty text={workers.isLoading ? '载入中…' : '还没有机器'} />
        )}
      </Panel>
    </Section>
  );
}
