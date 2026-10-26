import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi, RequestFailed } from './api.ts';
import type { AdminUserDto, AdminWorkerDto, SettingsDto } from './api.ts';
import { AccountMenu, useAccount } from './auth.tsx';
import { relativeTime } from './workers.tsx';
import { formatRoute, type AdminTab } from './route.ts';

/**
 * 运营后台（#/admin/<分页>），只有主人能进；服务端对 /api/admin/* 同样只认主人。
 * 窄屏下分页是顶部横向滚动的一排，宽屏是左侧栏。
 */
const TABS: readonly { readonly id: AdminTab; readonly label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'users', label: '用户' },
  { id: 'workers', label: '机器' },
  { id: 'settings', label: '设置' },
  { id: 'audit', label: '审计' }
];

const INPUT =
  'w-full rounded-sm border border-hair bg-card px-2.5 py-2 text-body text-primary outline-none placeholder:text-tertiary focus:border-accent';
const SMALL =
  'rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-accent hover:text-accent disabled:opacity-40';
const DANGER =
  'rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-rust hover:text-rust disabled:opacity-40';

const at = (time: number | null | undefined) => relativeTime(time ?? undefined);
const errorText = (error: unknown) => (error instanceof RequestFailed ? error.detail.message : '操作失败，再试一次');

export function AdminPage({ tab }: { tab: AdminTab }) {
  const account = useAccount();
  if (account?.role !== 'owner') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-head text-primary">只有主人能进运营后台</p>
        <a className="text-meta text-accent" href={formatRoute({ page: 'home' })}>
          回首页
        </a>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col md:flex-row">
      <nav aria-label="后台分页" className="shrink-0 border-b border-hair md:w-[200px] md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 px-3 pt-3 md:pt-4">
          <div className="min-w-0">
            <a className="text-meta text-tertiary hover:text-accent" href={formatRoute({ page: 'home' })}>
              ← agent-hub
            </a>
            <p className="text-head text-primary">运营后台</p>
          </div>
          <AccountMenu />
        </div>
        <ul className="flex gap-1 overflow-x-auto px-2 py-2 md:flex-col md:gap-0.5 md:px-2 md:py-3">
          {TABS.map((item) => (
            <li key={item.id} className="shrink-0">
              <a
                href={formatRoute({ page: 'admin', tab: item.id })}
                aria-current={item.id === tab ? 'page' : undefined}
                className={`block rounded-sm px-3 py-1.5 text-body ${
                  item.id === tab ? 'bg-card text-primary' : 'text-secondary hover:bg-card'
                }`}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <main className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6">
        <div className="mx-auto max-w-[880px]">
          {tab === 'overview' && <Overview />}
          {tab === 'users' && <Users />}
          {tab === 'workers' && <Workers />}
          {tab === 'settings' && <Settings />}
          {tab === 'audit' && <Audit />}
        </div>
      </main>
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-sub text-primary">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const Panel = ({ children }: { children: ReactNode }) => (
  <div className="rounded-md border border-hair bg-panel">{children}</div>
);
const Empty = ({ text }: { text: string }) => <p className="px-3 py-4 text-meta text-tertiary">{text}</p>;

function Overview() {
  const overview = useQuery({ queryKey: ['admin', 'overview'], queryFn: adminApi.overview, refetchInterval: 15_000 });
  const data = overview.data;
  const stats: [string, string][] = data
    ? [
        ['用户', `${data.users}${data.disabledUsers ? `（${data.disabledUsers} 停用）` : ''}`],
        ['在线机器', `${data.onlineWorkers} / ${data.workers}`],
        ['运行中会话', String(data.runningSessions)]
      ]
    : [];
  return (
    <>
      <Section title="概览">
        <div className="grid grid-cols-3 gap-2">
          {stats.map(([label, value]) => (
            <div key={label} className="rounded-md border border-hair bg-panel px-3 py-2.5">
              <p className="text-meta text-tertiary">{label}</p>
              <p className="mt-0.5 text-head text-primary">{value}</p>
            </div>
          ))}
        </div>
      </Section>
      <Section title="最近注册">
        <Panel>
          {data?.recentUsers.length ? (
            <ul>
              {data.recentUsers.map((user) => (
                <li
                  key={user.email}
                  className="flex items-baseline gap-2 border-b border-hair px-3 py-2 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-body text-primary">{user.email}</span>
                  <span className="shrink-0 text-meta text-tertiary">
                    {user.role === 'owner' ? '主人' : '成员'} · {at(user.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty text="还没有人注册" />
          )}
        </Panel>
      </Section>
      <Section title="最近登录">
        <Panel>
          {data?.recentLogins.length ? (
            <ul>
              {data.recentLogins.map((login, index) => (
                <li key={index} className="border-b border-hair px-3 py-2 last:border-b-0">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-body text-primary">{login.email}</span>
                    <span className="shrink-0 text-meta text-tertiary">{at(login.at)}</span>
                  </div>
                  <p className="truncate text-meta text-tertiary">
                    {login.method === 'password' ? '密码' : login.method} · {login.userAgent ?? '未知设备'}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty text="暂无登录记录" />
          )}
        </Panel>
      </Section>
    </>
  );
}

/** 写操作的通用外壳：成功后刷新后台数据，失败把服务端原话亮出来。 */
function useAdminAction<T>(run: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] })
  });
}

function Users() {
  const me = useAccount();
  const [q, setQ] = useState('');
  const users = useQuery({ queryKey: ['admin', 'users', q], queryFn: () => adminApi.users(q) });
  const action = useAdminAction(
    ({ kind, user }: { kind: 'disable' | 'enable' | 'promote' | 'demote' | 'revoke'; user: AdminUserDto }) => {
      if (kind === 'disable') return adminApi.disable(user.id);
      if (kind === 'enable') return adminApi.enable(user.id);
      if (kind === 'promote') return adminApi.setRole(user.id, 'owner');
      if (kind === 'demote') return adminApi.setRole(user.id, 'member');
      return adminApi.revokeLogins(user.id);
    }
  );
  return (
    <Section title="用户" aside={<span className="text-meta text-tertiary">{users.data?.length ?? 0} 人</span>}>
      <input
        className={`${INPUT} mb-2`}
        placeholder="按邮箱或名字搜索"
        aria-label="搜索用户"
        value={q}
        onChange={(event) => setQ(event.target.value)}
      />
      {action.error ? (
        <p role="alert" className="mb-2 text-meta text-rust">
          {errorText(action.error)}
        </p>
      ) : null}
      <Panel>
        {users.data?.length ? (
          <ul>
            {users.data.map((user) => {
              const self = user.id === me?.id;
              return (
                <li key={user.id} data-testid="admin-user" className="border-b border-hair px-3 py-2.5 last:border-b-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span
                      className={`min-w-0 truncate text-body ${user.disabled ? 'text-tertiary line-through' : 'text-primary'}`}
                    >
                      {user.email}
                    </span>
                    <span className="text-meta text-tertiary">
                      {user.role === 'owner' ? '主人' : '成员'}
                      {self ? ' · 你' : ''}
                      {user.disabled ? ' · 已停用' : ''}
                    </span>
                  </div>
                  <p className="text-meta text-tertiary">
                    最近活跃 {user.lastSeenAt ? at(user.lastSeenAt) : '从未'} · {user.activeLogins} 个有效登录 · 注册于{' '}
                    {at(user.createdAt)}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {user.role === 'member' ? (
                      <button
                        className={SMALL}
                        disabled={action.isPending}
                        onClick={() => action.mutate({ kind: 'promote', user })}
                      >
                        设为主人
                      </button>
                    ) : (
                      <button
                        className={SMALL}
                        disabled={action.isPending}
                        onClick={() => action.mutate({ kind: 'demote', user })}
                      >
                        降为成员
                      </button>
                    )}
                    <button
                      className={SMALL}
                      disabled={action.isPending}
                      onClick={() => action.mutate({ kind: 'revoke', user })}
                    >
                      {self ? '退出其他设备' : '踢下线'}
                    </button>
                    {user.disabled ? (
                      <button
                        className={SMALL}
                        disabled={action.isPending}
                        onClick={() => action.mutate({ kind: 'enable', user })}
                      >
                        启用
                      </button>
                    ) : self ? null : (
                      <button
                        className={DANGER}
                        disabled={action.isPending}
                        onClick={() => {
                          if (window.confirm(`停用 ${user.email}？对方会立刻掉线，不能再登录。`))
                            action.mutate({ kind: 'disable', user });
                        }}
                      >
                        停用
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty text={users.isLoading ? '载入中…' : '没有匹配的用户'} />
        )}
      </Panel>
    </Section>
  );
}

const UPDATE_TEXT: Record<string, string> = {
  updating: '更新中',
  succeeded: '更新成功',
  failed: '更新失败',
  refused: '拒绝更新'
};

const shortCommit = (commit: string | null | undefined): string => (commit ? commit.slice(0, 7) : '无提交号');
const buildText = (build: AdminWorkerDto['build']): string =>
  build ? `v${build.version} · ${shortCommit(build.commit)}` : '版本未知（旧版 Worker）';

function Workers() {
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
                  <p data-testid="worker-version" className="truncate pl-4 text-meta text-tertiary">
                    {buildText(worker.build)}
                  </p>
                  {worker.update ? (
                    <div data-testid="worker-update" className="pl-4 text-meta">
                      <span
                        className={
                          worker.update.state === 'failed' || worker.update.state === 'refused'
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

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 border-b border-hair px-3 py-3 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className="block text-body text-primary">{label}</span>
        <span className="block text-meta text-tertiary">{hint}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function Settings() {
  const settings = useQuery({ queryKey: ['admin', 'settings'], queryFn: adminApi.settings });
  const save = useAdminAction((patch: Partial<SettingsDto>) => adminApi.saveSettings(patch));
  const data = settings.data;
  return (
    <Section title="设置">
      {save.error ? (
        <p role="alert" className="mb-2 text-meta text-rust">
          {errorText(save.error)}
        </p>
      ) : null}
      <Panel>
        {data ? (
          <>
            <Toggle
              label="开放注册"
              hint="关掉后只有已有账号能登录；新人注册会被服务端拒绝。"
              checked={data.openRegistration}
              disabled={save.isPending}
              onChange={(openRegistration) => save.mutate({ openRegistration })}
            />
            <Toggle
              label="成员可以加机器"
              hint="关掉后只有主人能看到接入新 Worker 的说明。"
              checked={data.membersCanAddMachines}
              disabled={save.isPending}
              onChange={(membersCanAddMachines) => save.mutate({ membersCanAddMachines })}
            />
          </>
        ) : (
          <Empty text="载入中…" />
        )}
      </Panel>
    </Section>
  );
}

const ACTION_LABEL: Record<string, string> = {
  'user.disable': '停用用户',
  'user.enable': '启用用户',
  'user.role': '改角色',
  'user.revoke_logins': '踢下线',
  'settings.update': '改设置',
  'worker.disconnect': '断开机器',
  'worker.update': '更新机器',
  'worker.pair': '签发接入码',
  'worker.enroll': '接入机器',
  'worker.revoke': '吊销机器'
};

function Audit() {
  const audit = useQuery({ queryKey: ['admin', 'audit'], queryFn: adminApi.audit });
  return (
    <Section title="审计日志" aside={<span className="text-meta text-tertiary">最近 100 条</span>}>
      <Panel>
        {audit.data?.length ? (
          <ul>
            {audit.data.map((entry) => (
              <li key={entry.id} data-testid="audit-entry" className="border-b border-hair px-3 py-2 last:border-b-0">
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 text-body text-primary">{ACTION_LABEL[entry.action] ?? entry.action}</span>
                  <span className="min-w-0 flex-1 truncate text-body text-secondary">{entry.target}</span>
                  <span className="shrink-0 text-meta text-tertiary">{at(entry.at)}</span>
                </div>
                <p className="truncate text-meta text-tertiary">
                  {entry.actorEmail}
                  {entry.detail ? ` · ${entry.detail}` : ''}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text={audit.isLoading ? '载入中…' : '还没有管理操作'} />
        )}
      </Panel>
    </Section>
  );
}
