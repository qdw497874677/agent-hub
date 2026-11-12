import { useQuery } from '@tanstack/react-query';
import { adminApi } from '../api.ts';
import type { SettingsDto } from '../api.ts';
import { at, Section, Panel, Empty, errorText, useAdminAction } from './shared.tsx';

export function Overview() {
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
      <PlatformSettings />
    </>
  );
}

/** 平台设置：hub 级别的两个开关。原先是独立一页，现在并到概览底部（这两个改动不常发生）。 */
function PlatformSettings() {
  const settings = useQuery({ queryKey: ['admin', 'settings'], queryFn: adminApi.settings });
  const save = useAdminAction((patch: Partial<SettingsDto>) => adminApi.saveSettings(patch));
  const data = settings.data;
  return (
    <Section title="平台设置">
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
              hint="默认关闭。打开后任何人都能自助注册：验证邮箱后得到一个自己的空团队（仍受 HUB_MAX_USERS 限制），看不到别的团队，也用不了 hub 本机。"
              checked={data.openRegistration}
              disabled={save.isPending}
              onChange={(openRegistration) => save.mutate({ openRegistration })}
            />
            <Toggle
              label="成员可以加机器"
              hint="关掉后只有主人能看到接入新机器的说明。"
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
