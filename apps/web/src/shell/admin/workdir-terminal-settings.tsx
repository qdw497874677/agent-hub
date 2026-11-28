import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { call } from '../api/http.ts';
import { DANGER, INPUT, Panel, Section, SMALL } from './shared.tsx';

type Settings = {
  mode: 'managed' | 'deployment' | 'unavailable';
  enabled: boolean;
  canEnable: boolean;
  blockedReason: string | null;
  workers: { id: string; label: string }[];
  users: { id: string; label: string }[];
  grants: { userId: string; workerId: string }[];
};
type Action =
  | { action: 'set-enabled'; enabled: boolean }
  | { action: 'grant' | 'revoke'; userId: string; workerId: string };

const path = '/api/admin/workdir-terminal-settings';
const labelFor = (items: { id: string; label: string }[], id: string) =>
  items.find((item) => item.id === id)?.label || id;

export function WorkdirTerminalSettings() {
  const settings = useQuery({
    queryKey: ['admin', 'workdir-terminal-settings'],
    queryFn: () => call<Settings>(path),
    retry: false
  });
  const [userId, setUserId] = useState('');
  const [workerId, setWorkerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [notice, setNotice] = useState('');
  const data = settings.data;
  const locked = busy || needsRefresh || settings.isFetching || settings.isError;

  async function refresh() {
    try {
      await settings.refetch({ throwOnError: true });
      setNeedsRefresh(false);
      return true;
    } catch {
      setNeedsRefresh(true);
      return false;
    }
  }

  async function save(action: Action) {
    if (locked) return;
    setBusy(true);
    setNotice('');
    let failed = false;
    try {
      await call<Settings>(path, { method: 'PUT', body: JSON.stringify(action) });
    } catch {
      failed = true;
    }
    const refreshed = await refresh();
    setNotice(
      !refreshed
        ? '无法读取最新设置，保存结果尚不确定。请先重新读取；不会自动重试保存。'
        : failed
          ? '保存未确认，已重新读取当前设置。请核对后再决定是否操作。'
          : '设置已更新。'
    );
    setBusy(false);
  }

  const alreadyGranted = data?.grants.some((grant) => grant.userId === userId && grant.workerId === workerId);
  const validSelection = data?.users.some((user) => user.id === userId) && data.workers.some((worker) => worker.id === workerId);
  return (
    <Section title="工作目录终端">
      <Panel>
        <div className="space-y-4 px-3 py-3" data-testid="workdir-terminal-settings">
          {!data && !settings.isError ? <p className="text-meta text-tertiary">载入中…</p> : null}
          {!data && settings.isError ? (
            <div role="alert" className="text-meta text-rust">
              <p>无法读取终端设置。</p>
              <button type="button" className={`${SMALL} mt-2 min-h-11`} onClick={() => void refresh()}>重新读取</button>
            </div>
          ) : null}
          {data ? (
            <>
              {data.mode === 'unavailable' ? (
                <p role="status" className="text-body text-secondary">{data.blockedReason || '当前无法使用工作目录终端。'}</p>
              ) : (
                <>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-body text-primary">允许新建工作目录终端</p>
                      <p className="mt-1 text-meta text-tertiary">关闭后仅停止新建，不会关闭已打开的终端。每个人还需要单独获得机器授权。</p>
                      {data.mode === 'deployment' ? <p className="mt-1 text-meta text-tertiary">此设置由部署配置控制，无法在此修改。</p> : null}
                      {data.mode === 'managed' && !data.enabled && !data.canEnable && data.blockedReason ? <p className="mt-1 text-meta text-rust">{data.blockedReason}</p> : null}
                    </div>
                    {data.mode === 'managed' ? (
                      <label className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center">
                        <input
                          type="checkbox"
                          role="switch"
                          aria-label="允许新建工作目录终端"
                          data-testid="workdir-terminal-enabled"
                          className="h-4 w-4 accent-[var(--color-fg)]"
                          checked={data.enabled}
                          disabled={locked || (!data.enabled && !data.canEnable)}
                          onChange={(event) => {
                            const enabled = event.target.checked;
                            if (enabled && !window.confirm('允许新建工作目录终端？启用后，不兼容的机器上的目录操作可能受到影响。')) return;
                            void save({ action: 'set-enabled', enabled });
                          }}
                        />
                      </label>
                    ) : <span className="pt-2 text-meta text-secondary">{data.enabled ? '已开启' : '已关闭'}</span>}
                  </div>

                  <div className="border-t border-hair pt-3">
                    <h3 className="text-body text-primary">人员与机器授权</h3>
                    <p className="mt-1 text-meta text-tertiary">按人员和机器分别授权；默认没有人获得授权。</p>
                    {data.mode === 'managed' ? (
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                        <label className="min-w-0 flex-1 text-meta text-secondary">人员
                          <select aria-label="选择人员" data-testid="workdir-terminal-user" className={`${INPUT} mt-1 min-h-11`} value={userId} onChange={(event) => setUserId(event.target.value)} disabled={locked}>
                            <option value="">选择人员</option>
                            {data.users.map((user) => <option key={user.id} value={user.id}>{user.label || user.id}</option>)}
                          </select>
                        </label>
                        <label className="min-w-0 flex-1 text-meta text-secondary">机器
                          <select aria-label="选择机器" data-testid="workdir-terminal-worker" className={`${INPUT} mt-1 min-h-11`} value={workerId} onChange={(event) => setWorkerId(event.target.value)} disabled={locked}>
                            <option value="">选择机器</option>
                            {data.workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.label || worker.id}</option>)}
                          </select>
                        </label>
                        <button type="button" data-testid="workdir-terminal-grant" className={`${SMALL} min-h-11 px-3`} disabled={locked || !validSelection || alreadyGranted} onClick={() => void save({ action: 'grant', userId, workerId })}>添加授权</button>
                      </div>
                    ) : null}
                    {data.grants.length ? (
                      <ul className="mt-3">
                        {data.grants.map((grant) => {
                          const user = labelFor(data.users, grant.userId);
                          const worker = labelFor(data.workers, grant.workerId);
                          return (
                            <li key={JSON.stringify([grant.userId, grant.workerId])} data-testid="workdir-terminal-grant-row" className="flex items-center gap-3 border-t border-hair py-1">
                              <span className="min-w-0 flex-1 break-words text-meta text-secondary">{user} <span className="text-tertiary">→</span> {worker}</span>
                              {data.mode === 'managed' ? <button type="button" aria-label={`撤销 ${user} 在 ${worker} 的授权`} className={`${DANGER} min-h-11 shrink-0 px-3`} disabled={locked} onClick={() => {
                                if (window.confirm(`撤销 ${user} 在 ${worker} 的授权？这会关闭该人员在此机器上相关的终端。`)) void save({ action: 'revoke', ...grant });
                              }}>撤销</button> : null}
                            </li>
                          );
                        })}
                      </ul>
                    ) : <p className="mt-3 text-meta text-tertiary">暂无授权</p>}
                  </div>
                </>
              )}
              {notice ? <p role="status" className="text-meta text-secondary">{notice}</p> : null}
              {(needsRefresh || settings.isError) ? <div><p role="alert" className="text-meta text-rust">无法读取最新设置，已暂停修改。</p><button type="button" className={`${SMALL} mt-2 min-h-11`} disabled={busy || settings.isFetching} onClick={() => void refresh().then((ok) => setNotice(ok ? '已重新读取当前设置，请核对后再操作。' : '仍无法读取最新设置，请稍后再试。'))}>重新读取</button></div> : null}
            </>
          ) : null}
        </div>
      </Panel>
    </Section>
  );
}
