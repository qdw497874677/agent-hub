import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accessApi, RequestFailed, type AccessCatalogDto, type PermissionScope, type RoleViewDto } from './api.ts';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from './dialog-shell.tsx';

/**
 * 团队角色（ADR 0017 决定 3A / 6B）：内置 owner / admin / member / viewer + 团队自定义角色。
 * - 矩阵：宽屏一张表（权限 × 角色），窄屏按资源分组的卡片；
 * - 自定义角色编辑器：每项权限「无 / 自己的 / 全团队」三档；hub.* 和 team.roles 不出现（永远不能授）。
 */
const KIND_LABEL: Record<string, string> = {
  worker: '机器', project: '项目', task: '任务', session: '会话', provider: '模型提供商', token: '令牌', audit: '审计', team: '团队', asset: '资产（技能 / MCP）', hub: 'hub（只给集群管理员）'
};
const PERM_LABEL: Record<string, string> = {
  read: '查看', use: '使用', enroll: '接入', manage: '管理', policy: '策略', delete: '删除', 'runtime.install': '装运行时', 'runtime.component.install': '装组件', create: '新建', update: '修改',
  share: '分享', restore: '恢复', purge: '彻底删除', prompt: '发消息', interrupt: '打断', fork: '分叉', continue: '换机继续', service: '服务令牌',
  invite: '邀请', roles: '定义角色', grants: '单独授权', settings: '设置', users: '用户', assets: '资产', providers: '全站提供商', visit: '临时进入', submit: '提交', review: '审核', assign: '分配', retire: '下架', 'secret.use': '用密钥', publish_global: '发布到全站'
};
const ROLE_NAME: Record<string, string> = { owner: '主人', admin: '管理员', member: '成员', viewer: '只读' };
/** 只有「全团队」一档有意义的权限：团队管理类。 */
const TEAM_ONLY_KINDS = new Set(['team', 'audit', 'token']);

export const roleName = (role: { key: string; name: string; builtin: boolean }) => (role.builtin ? (ROLE_NAME[role.key] ?? role.key) : role.name);
const permLabel = (kind: string, perm: string) => PERM_LABEL[perm.slice(kind.length + 1)] ?? PERM_LABEL[perm.split('.').slice(1).join('.')] ?? perm;
const errorOf = (error: unknown) => (error instanceof RequestFailed ? error.message : error ? '出错了' : null);

function scopeText(scope: PermissionScope | undefined): string {
  return scope === 'team' ? '全团队' : scope === 'own' ? '自己的' : '—';
}

function ScopeCell({ scope }: { scope: PermissionScope | undefined }) {
  return (
    <span className={scope === 'team' ? 'text-primary' : scope === 'own' ? 'text-secondary' : 'text-tertiary'} data-scope={scope ?? 'none'}>
      {scopeText(scope)}
    </span>
  );
}

/** 权限矩阵：只读视图。 */
export function RoleMatrix({ catalog, roles }: { catalog: AccessCatalogDto; roles: readonly RoleViewDto[] }) {
  const kinds = Object.keys(catalog.catalog).filter((kind) => kind !== 'hub');
  return (
    <div data-testid="role-matrix">
      <div className="hidden overflow-x-auto rounded-sm border border-hair md:block">
        <table className="w-full border-collapse text-meta">
          <thead>
            <tr className="bg-card">
              <th className="sticky left-0 bg-card px-2 py-1.5 text-left font-normal text-tertiary">权限</th>
              {roles.map((role) => (
                <th key={role.key} className="px-2 py-1.5 text-left font-normal text-secondary">{roleName(role)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {kinds.flatMap((kind) =>
              (catalog.catalog[kind] ?? []).map((perm, index) => (
                <tr key={perm} className="border-t border-hair">
                  <td className="sticky left-0 whitespace-nowrap bg-canvas px-2 py-1 text-secondary">
                    {index === 0 ? <span className="mr-1 text-tertiary">{KIND_LABEL[kind] ?? kind} ·</span> : <span className="mr-1 inline-block w-0" />}
                    {permLabel(kind, perm)}
                  </td>
                  {roles.map((role) => (
                    <td key={role.key} className="px-2 py-1"><ScopeCell scope={role.permissions[perm]} /></td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-2 md:hidden">
        {kinds.map((kind) => (
          <details key={kind} className="rounded-sm border border-hair bg-card px-3 py-2">
            <summary className="cursor-pointer text-meta text-primary">{KIND_LABEL[kind] ?? kind}</summary>
            <ul className="mt-2 flex flex-col gap-1.5">
              {(catalog.catalog[kind] ?? []).map((perm) => (
                <li key={perm} className="text-[12px]">
                  <p className="text-secondary">{permLabel(kind, perm)}</p>
                  <p className="flex flex-wrap gap-x-3 text-tertiary">
                    {roles.map((role) => (
                      <span key={role.key}>{roleName(role)} <ScopeCell scope={role.permissions[perm]} /></span>
                    ))}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </div>
  );
}

/** 自定义角色编辑器：按资源分组，每项一个三档开关。 */
function RoleEditor({ catalog, initial, onDone }: { catalog: AccessCatalogDto; initial?: RoleViewDto; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial?.name ?? '');
  const [perms, setPerms] = useState<Record<string, PermissionScope>>({ ...(initial?.permissions ?? {}) });
  const grantable = useMemo(() => new Set(catalog.grantable), [catalog]);
  const save = useMutation({
    mutationFn: () => (initial?.id ? accessApi.updateRole(initial.id, name.trim(), perms) : accessApi.createRole(name.trim(), perms)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['team'] });
      onDone();
    }
  });
  const set = (perm: string, scope: PermissionScope | null) =>
    setPerms((current) => {
      const next = { ...current };
      if (scope) next[perm] = scope;
      else delete next[perm];
      return next;
    });
  return (
    <form
      data-testid="role-editor"
      className="flex flex-col gap-3 rounded-sm border border-hair bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() && !save.isPending) save.mutate();
      }}
    >
      <label className="flex flex-col gap-1 text-meta text-secondary">
        角色名
        <input className={INPUT} value={name} maxLength={40} placeholder="比如：评审员" onChange={(e) => setName(e.target.value)} aria-label="角色名" />
      </label>
      {Object.keys(catalog.catalog)
        .filter((kind) => (catalog.catalog[kind] ?? []).some((perm) => grantable.has(perm)))
        .map((kind) => (
          <fieldset key={kind} className="flex flex-col gap-1.5">
            <legend className="mb-1 text-meta text-tertiary">{KIND_LABEL[kind] ?? kind}</legend>
            {(catalog.catalog[kind] ?? [])
              .filter((perm) => grantable.has(perm))
              .map((perm) => {
                const options: (PermissionScope | null)[] = TEAM_ONLY_KINDS.has(kind) ? [null, 'team'] : [null, 'own', 'team'];
                return (
                  <div key={perm} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-meta text-primary">{permLabel(kind, perm)}</span>
                    <div role="radiogroup" aria-label={perm} className="flex shrink-0 overflow-hidden rounded-sm border border-hair">
                      {options.map((option) => {
                        const on = (perms[perm] ?? null) === option;
                        return (
                          <button
                            key={option ?? 'none'}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            data-perm={perm}
                            data-option={option ?? 'none'}
                            onClick={() => set(perm, option)}
                            className={`min-h-[32px] min-w-[52px] px-2 text-[12px] ${on ? 'bg-accent text-canvas' : 'text-secondary hover:text-primary'}`}
                          >
                            {option === null ? '无' : option === 'own' ? '自己的' : '全团队'}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
          </fieldset>
        ))}
      <p className="text-[11px] text-tertiary">hub 级权限（设置、用户、hub 本机 Worker）和「定义角色」永远不能放进自定义角色。</p>
      {save.error ? <p role="alert" className="text-meta text-rust">{errorOf(save.error)}</p> : null}
      <div className="flex gap-2">
        <button type="submit" className={PRIMARY_BUTTON} disabled={!name.trim() || save.isPending}>{save.isPending ? '保存中…' : '保存角色'}</button>
        <button type="button" className={SECONDARY_BUTTON} onClick={onDone}>取消</button>
      </div>
    </form>
  );
}

/** 团队页里的「角色与权限」：矩阵 + 自定义角色列表；owner 才能编辑。 */
export function TeamRoles({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const catalog = useQuery({ queryKey: ['team', 'catalog'], queryFn: accessApi.catalog, staleTime: Infinity });
  const roles = useQuery({ queryKey: ['team', 'roles'], queryFn: accessApi.roles });
  const [editing, setEditing] = useState<RoleViewDto | 'new' | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => accessApi.deleteRole(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['team'] })
  });
  if (!catalog.data || !roles.data) return <p className="text-meta text-tertiary">加载中…</p>;
  const custom = roles.data.filter((role) => !role.builtin);
  return (
    <div className="flex flex-col gap-3">
      <RoleMatrix catalog={catalog.data} roles={roles.data} />
      <div className="flex items-center justify-between">
        <p className="text-meta text-secondary">自定义角色 {custom.length ? `（${custom.length}）` : ''}</p>
        {canEdit && editing === null ? (
          <button className={SECONDARY_BUTTON} data-testid="new-role" onClick={() => setEditing('new')}>新建角色</button>
        ) : null}
      </div>
      {editing ? <RoleEditor catalog={catalog.data} initial={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} /> : null}
      <ul className="flex flex-col gap-2">
        {custom.map((role) => (
          <li key={role.key} data-testid="custom-role" className="flex items-center gap-2 rounded-sm border border-hair bg-card px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-meta text-primary">{role.name}</p>
              <p className="truncate text-[11px] text-tertiary">{Object.keys(role.permissions).length} 项权限 · {role.members} 人</p>
            </div>
            {canEdit ? (
              <>
                <button className={SECONDARY_BUTTON} onClick={() => setEditing(role)}>编辑</button>
                <button
                  className={SECONDARY_BUTTON}
                  disabled={remove.isPending}
                  onClick={() => window.confirm(`删除角色「${role.name}」？`) && remove.mutate(role.id!)}
                >
                  删除
                </button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {remove.error ? <p role="alert" className="text-meta text-rust">{errorOf(remove.error)}</p> : null}
    </div>
  );
}

/** 单独授权（比如让某人能在别人的会话里说话）：列表 + 撤销。 */
export function TeamGrants({ names }: { names: ReadonlyMap<string, string> }) {
  const queryClient = useQueryClient();
  const grants = useQuery({ queryKey: ['team', 'grants'], queryFn: accessApi.grants });
  const revoke = useMutation({
    mutationFn: (id: string) => accessApi.revokeGrant(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['team', 'grants'] })
  });
  const active = (grants.data ?? []).filter((grant) => grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > Date.now()));
  if (!active.length) return <p className="text-meta text-tertiary">没有单独授权。</p>;
  return (
    <ul className="flex flex-col gap-2">
      {active.map((grant) => (
        <li key={grant.id} data-testid="team-grant" className="flex items-center gap-2 rounded-sm border border-hair bg-card px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-meta text-primary">{names.get(grant.userId) ?? grant.userId} · {grant.permission}</p>
            <p className="truncate text-[11px] text-tertiary">{grant.resourceKind}:{grant.resourceId}{grant.reason ? ` · ${grant.reason}` : ''}</p>
          </div>
          <button className={SECONDARY_BUTTON} disabled={revoke.isPending} onClick={() => revoke.mutate(grant.id)}>撤销</button>
        </li>
      ))}
    </ul>
  );
}

const DURATIONS = [
  { label: '1 小时', ms: 3_600_000 },
  { label: '4 小时', ms: 4 * 3_600_000 },
  { label: '24 小时', ms: 24 * 3_600_000 }
];

/** 集群管理员临时进入别的团队（决定 5A）：只读、写原因、会到期；两边审计各一条。 */
export function VisitPanel({ myTeamId }: { myTeamId: string | null }) {
  const queryClient = useQueryClient();
  const teams = useQuery({ queryKey: ['admin', 'teams'], queryFn: accessApi.teams });
  const visits = useQuery({ queryKey: ['access', 'visits'], queryFn: accessApi.visits });
  const [teamId, setTeamId] = useState('');
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState(DURATIONS[0]!.ms);
  const refresh = () => queryClient.invalidateQueries();
  const start = useMutation({ mutationFn: () => accessApi.startVisit(teamId, reason.trim(), duration), onSuccess: async () => { setReason(''); await refresh(); } });
  const end = useMutation({ mutationFn: (id: string) => accessApi.endVisit(id), onSuccess: refresh });
  const others = (teams.data ?? []).filter((team) => team.id !== myTeamId);
  const nameOf = new Map((teams.data ?? []).map((team) => [team.id, team.name]));
  return (
    <section data-testid="visit-panel" className="mb-4 rounded-sm border border-hair bg-card p-3">
      <p className="text-sub text-primary">临时进入团队</p>
      <p className="mt-1 text-meta text-tertiary">集群管理员默认看不到别的团队的数据。排查问题时可以只读进入一段时间，原因会写进 hub 审计和对方团队审计。</p>
      {(visits.data ?? []).map((visit) => (
        <div key={visit.id} data-testid="active-visit" className="mt-2 flex items-center gap-2 rounded-sm border border-accent px-3 py-2">
          <p className="min-w-0 flex-1 truncate text-meta text-primary">
            正在只读访问 {nameOf.get(visit.resourceId) ?? visit.resourceId} · 至 {new Date(visit.expiresAt ?? 0).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', month: 'numeric', day: 'numeric' })}
          </p>
          <button className={SECONDARY_BUTTON} disabled={end.isPending} onClick={() => end.mutate(visit.id)}>结束</button>
        </div>
      ))}
      <form
        className="mt-3 flex flex-col gap-2 md:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (teamId && reason.trim() && !start.isPending) start.mutate();
        }}
      >
        <select aria-label="要进入的团队" className={`${INPUT} md:w-48`} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">选团队…</option>
          {others.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
        </select>
        <input aria-label="原因" className={INPUT} placeholder="原因（必填，会进审计）" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
        <select aria-label="时长" className={`${INPUT} md:w-28`} value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
          {DURATIONS.map((item) => <option key={item.ms} value={item.ms}>{item.label}</option>)}
        </select>
        <button type="submit" className={PRIMARY_BUTTON} disabled={!teamId || reason.trim().length < 4 || start.isPending}>进入</button>
      </form>
      {start.error || end.error ? <p role="alert" className="mt-2 text-meta text-rust">{errorOf(start.error ?? end.error)}</p> : null}
    </section>
  );
}
