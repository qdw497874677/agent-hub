import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminApi, teamApi, type AuditFilterInput } from '../api.ts';
import { localizeInstants } from '../local-time.ts';
import { INPUT, SMALL, at, Section, Panel, Empty } from './shared.tsx';

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
  'worker.revoke': '吊销机器',
  'asset.create': '添加资产',
  'asset.revision': '资产新版本',
  'asset.pin': '升级资产',
  'asset.delete': '删除资产',
  'asset.install': '装资产',
  'asset.secret.set': '设置密钥',
  'asset.secret.delete': '删除密钥',
  'asset.project': '项目资产开关',
  'asset.uninstall': '卸资产',
  'asset.submit': '提交资产审核',
  'asset.approve': '审核通过',
  'asset.self_approve': '自审通过（已标记）',
  'asset.reject': '驳回资产',
  'asset.request_changes': '要求修改',
  'asset.publish': '发布资产',
  'asset.withdraw': '撤回提交',
  'asset.revoke': '下架资产',
  'asset.comment': '审核评论',
  'asset.install_request': '申请装资产',
  'asset.install_decide': '处理安装申请',
  'asset.review_settings': '改审核设置',
  'asset.migrate': '资产迁移',
  'user.verify': '标记已验证',
  'user.delete': '删除用户',
  'runtime.install': '装运行时',
  'runtime.uninstall': '卸运行时',
  'runtime.component.install': '装组件',
  'runtime.component.uninstall': '卸组件',
  'bundle.submit': '提交组件',
  'bundle.review': '审核组件',
  'bundle.script_run': '组件安装脚本',
  'bundle.integrity_mismatch': '组件校验不符',
  'project.create': '建项目',
  'project.delete': '删项目',
  'project.restore': '恢复项目',
  'project.purge': '彻底删除项目',
  'project.share': '分享项目',
  'invite.create': '邀请',
  'session.start': '开会话',
  'session.fork': '分叉会话',
  'session.interrupt': '停会话',
  'session.continue': '换机继续',
  'invite.revoke': '撤销邀请',
  'auth.register': '注册',
  'auth.login': '登录',
  'auth.login_failed': '登录失败',
  'auth.logout': '退出登录',
  'auth.password_reset': '重置密码',
  'auth.password_change': '改密码',
  'auth.profile': '改显示名'
};

/** 动作下拉：按前缀分组筛，也能选单个动作。 */
const ACTION_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '全部动作' },
  { value: 'auth.', label: '登录与账号安全' },
  { value: 'auth.login_failed', label: '· 登录失败' },
  { value: 'user.', label: '用户管理' },
  { value: 'invite.', label: '邀请' },
  { value: 'project.', label: '项目' },
  { value: 'worker.', label: '机器' },
  { value: 'asset.', label: '资产' },
  { value: 'settings.', label: '设置' }
];

const RANGES: { value: string; label: string; ms: number | null }[] = [
  { value: 'all', label: '全部时间', ms: null },
  { value: '1h', label: '最近 1 小时', ms: 3_600_000 },
  { value: '24h', label: '最近 24 小时', ms: 86_400_000 },
  { value: '7d', label: '最近 7 天', ms: 7 * 86_400_000 },
  { value: '30d', label: '最近 30 天', ms: 30 * 86_400_000 }
];

/** 审计列表 + 过滤（动作、操作人、IP、时间）。admin 看全 hub；team 是团队主人看自己团队（服务端强制）。 */
export function AuditView({ source }: { source: 'admin' | 'team' }) {
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [ip, setIp] = useState('');
  const [range, setRange] = useState('all');
  const [applied, setApplied] = useState<{ actor: string; ip: string }>({ actor: '', ip: '' });
  const ms = RANGES.find((r) => r.value === range)?.ms ?? null;
  // 时间范围取到分钟，免得每次渲染都换 queryKey
  const since = ms === null ? undefined : Math.floor((Date.now() - ms) / 60_000) * 60_000;
  const filter: AuditFilterInput = { action, actor: applied.actor, ip: applied.ip, ...(since !== undefined ? { since } : {}) };
  const audit = useQuery({
    queryKey: [source === 'admin' ? 'admin' : 'team', 'audit', filter],
    queryFn: () => (source === 'admin' ? adminApi.audit(filter) : teamApi.audit(filter))
  });
  const filtered = action !== '' || applied.actor !== '' || applied.ip !== '' || range !== 'all';
  return (
    <>
      <form
        className="mb-2 flex flex-wrap gap-1.5"
        aria-label="审计过滤"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied({ actor: actor.trim(), ip: ip.trim() });
        }}
      >
        <select aria-label="动作" className={`${INPUT} w-auto`} value={action} onChange={(e) => setAction(e.target.value)}>
          {ACTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select aria-label="时间" className={`${INPUT} w-auto`} value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <input aria-label="操作人邮箱" placeholder="操作人邮箱" className={`${INPUT} w-36 flex-1`} value={actor} onChange={(e) => setActor(e.target.value)} />
        <input aria-label="IP" placeholder="IP（可只填前缀）" className={`${INPUT} w-32 flex-1`} value={ip} onChange={(e) => setIp(e.target.value)} />
        <button type="submit" className={SMALL}>筛选</button>
        {filtered && (
          <button
            type="button"
            className={SMALL}
            onClick={() => {
              setAction('');
              setActor('');
              setIp('');
              setRange('all');
              setApplied({ actor: '', ip: '' });
            }}
          >
            清空
          </button>
        )}
      </form>
      <Panel>
        {audit.data?.length ? (
          <ul>
            {audit.data.map((entry) => (
              <li key={entry.id} data-testid="audit-entry" className="border-b border-hair px-3 py-2 last:border-b-0">
                <div className="flex items-baseline gap-2">
                  <span className={`shrink-0 text-body ${entry.action === 'auth.login_failed' ? 'text-rust' : 'text-primary'}`}>
                    {ACTION_LABEL[entry.action] ?? entry.action}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-body text-secondary">{entry.target}</span>
                  <span className="shrink-0 text-meta text-tertiary">{at(entry.at)}</span>
                </div>
                <p className="truncate text-meta text-tertiary">
                  {entry.actorEmail || '（未知账号）'}
                  {entry.ip ? ` · ${entry.ip}` : ''}
                  {entry.detail ? ` · ${localizeInstants(entry.detail)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text={audit.isLoading ? '载入中…' : audit.isError ? '载入失败' : filtered ? '没有符合条件的记录' : '还没有记录'} />
        )}
      </Panel>
    </>
  );
}

export function Audit() {
  return (
    <Section title="审计日志" aside={<span className="text-meta text-tertiary">最多 100 条</span>}>
      <AuditView source="admin" />
    </Section>
  );
}


