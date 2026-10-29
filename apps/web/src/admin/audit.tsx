import { useQuery } from '@tanstack/react-query';
import { adminApi } from '../api.ts';
import { localizeInstants } from '../local-time.ts';
import { at, Section, Panel, Empty } from './shared.tsx';

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
  'asset.uninstall': '卸资产'
};

export function Audit() {
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
                  {entry.detail ? ` · ${localizeInstants(entry.detail)}` : ''}
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
