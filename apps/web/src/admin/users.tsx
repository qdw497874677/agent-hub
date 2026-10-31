import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminApi, teamApi } from '../api.ts';
import type { AdminUserDto } from '../api.ts';
import { useAccount } from '../auth.tsx';
import { VisitPanel } from '../team-roles.tsx';
import { INPUT, SMALL, DANGER, at, errorText, Section, Panel, Empty, useAdminAction } from './shared.tsx';

export function Users() {
  const me = useAccount();
  const [q, setQ] = useState('');
  const users = useQuery({ queryKey: ['admin', 'users', q], queryFn: () => adminApi.users(q) });
  const grant = useAdminAction(({ user, on }: { user: AdminUserDto; on: boolean }) => adminApi.setClusterAdmin(user.id, on));
  const admins = users.data?.filter((user) => user.clusterAdmin && !user.disabled).length ?? 0;
  const action = useAdminAction(
    ({ kind, user }: { kind: 'disable' | 'enable' | 'promote' | 'demote' | 'revoke' | 'verify' | 'delete'; user: AdminUserDto }) => {
      if (kind === 'disable') return adminApi.disable(user.id);
      if (kind === 'enable') return adminApi.enable(user.id);
      if (kind === 'promote') return adminApi.setRole(user.id, 'owner');
      if (kind === 'demote') return adminApi.setRole(user.id, 'member');
      if (kind === 'verify') return adminApi.markVerified(user.id);
      if (kind === 'delete') return teamApi.remove(user.id);
      return adminApi.revokeLogins(user.id);
    }
  );
  return (
    <Section title="用户" aside={<span className="text-meta text-tertiary">{users.data?.length ?? 0} 人</span>}>
      <VisitPanel myTeamId={users.data?.find((user) => user.id === me?.id)?.teamId ?? null} />
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
                      {user.clusterAdmin ? '集群管理员 · ' : ''}
                      {roleLabel(user.role)}
                      {user.hubTeam === false ? ' · 其他团队' : ''}
                      {self ? ' · 你' : ''}
                      {user.disabled ? ' · 已停用' : ''}
                    </span>
                    {!user.emailVerified && (
                      <span className="rounded-sm border border-hair px-1.5 text-[11px] text-rust">未验证邮箱</span>
                    )}
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
                    {!user.disabled ? (
                      <button
                        className={SMALL}
                        data-testid="toggle-cluster-admin"
                        disabled={grant.isPending || (user.clusterAdmin && admins <= 1)}
                        aria-pressed={user.clusterAdmin}
                        title={
                          user.clusterAdmin && admins <= 1
                            ? '至少要留一位集群管理员'
                            : '集群管理员管整个 hub（用户、设置、hub 本机 Worker），但看不了别的团队的数据，除非临时进入'
                        }
                        onClick={() => {
                          if (!user.clusterAdmin && !window.confirm(`把 ${user.email} 设为集群管理员？TA 将能使用 hub 本机 Worker、管理所有用户。`)) return;
                          grant.mutate({ user, on: !user.clusterAdmin });
                        }}
                      >
                        {user.clusterAdmin ? '撤销集群管理员' : '设为集群管理员'}
                      </button>
                    ) : null}
                    {!user.emailVerified && (
                      <button className={SMALL} disabled={action.isPending} onClick={() => action.mutate({ kind: 'verify', user })}>
                        标记已验证
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
                    {!self && !user.clusterAdmin ? (
                      <button
                        className={DANGER}
                        disabled={action.isPending}
                        onClick={() => {
                          if (window.confirm(`删除 ${user.email}？账号会被匿名化，项目转给 TA 的团队主人。不能撤销。`))
                            action.mutate({ kind: 'delete', user });
                        }}
                      >
                        删除
                      </button>
                    ) : null}
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

const ROLE_LABEL: Record<string, string> = { owner: '主人', admin: '管理员', member: '成员', viewer: '只读' };
export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? (role.startsWith('custom:') ? '自定义角色' : role);
}
