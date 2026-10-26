import { useQuery } from '@tanstack/react-query';
import { adminApi } from '../api.ts';
import { at, Section, Panel, Empty } from './shared.tsx';

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
    </>
  );
}
