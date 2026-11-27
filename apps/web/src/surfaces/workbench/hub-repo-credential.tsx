import { useEffect, useRef, useState } from 'react';
import { hubCredentialApi, type HubCredentialDetails, type HubCredentialCheck } from '../../shell/api/hub.ts';
import { INPUT, SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';

/** Hub 托管凭证只在管理接口里使用，绝不进入查询缓存或可回显状态。 */
export function HubRepoCredential({ projectId, repoId, targetChanged }: {
  readonly projectId: string;
  readonly repoId: string;
  readonly targetChanged: boolean;
}) {
  const [details, setDetails] = useState<HubCredentialDetails | null>(null);
  const [availability, setAvailability] = useState<'loading' | 'available' | 'hidden' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState('');
  const [form, setForm] = useState<'create' | 'rotate' | null>(null);
  const [rotationTarget, setRotationTarget] = useState<{ readonly credentialId: string; readonly version: number; readonly name: string } | null>(null);
  const [name, setName] = useState('');
  const secretRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const targetRevision = useRef(0);

  const load = async () => {
    const request = ++generation.current;
    try {
      const data = await hubCredentialApi.view(projectId, repoId);
      if (request !== generation.current) return;
      setDetails(data);
      setAvailability('available');
      setSelected((current) => data.credentials.some((item) => item.id === current) ? current : '');
    } catch (err) {
      if (request !== generation.current) return;
      setDetails(null);
      setAvailability(hubCredentialApi.unavailable(err) ? 'hidden' : 'error');
    }
  };
  useEffect(() => {
    void load();
    return () => { generation.current++; };
  }, [projectId, repoId]);
  useEffect(() => {
    targetRevision.current++;
    setNotice('');
    if (targetChanged) {
      if (secretRef.current) secretRef.current.value = '';
      setName('');
      setForm(null);
      setRotationTarget(null);
    }
  }, [targetChanged]);

  const clearForm = () => {
    if (secretRef.current) secretRef.current.value = '';
    setName('');
    setForm(null);
    setRotationTarget(null);
  };

  const run = async (action: () => Promise<unknown>, success: string | ((result: unknown) => string)) => {
    const revision = targetRevision.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await action();
      if (revision === targetRevision.current) setNotice(typeof success === 'function' ? success(result) : success);
      await load();
    } catch {
      // Never show raw server or network errors: they may contain sensitive material.
      setError('操作结果未确认，请先刷新状态或联系管理员，再决定是否重试。');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const submitSecret = () => {
    const credential = secretRef.current?.value ?? '';
    if (!credential || (form === 'create' && !name.trim())) return;
    if (!window.isSecureContext) {
      clearForm();
      setError('当前连接不安全，不能提交凭证。请通过安全连接打开 Hub。');
      return;
    }
    if (form === 'rotate' && (!rotationTarget || !window.confirm(`轮换「${rotationTarget.name}」（版本 ${rotationTarget.version}）会影响所有使用这份凭证的团队仓库。确认替换为同一外部身份的新凭证？`))) return;
    const operation = form;
    const credentialName = name.trim();
    const target = rotationTarget;
    clearForm();
    if (operation === 'create') {
      void run(() => hubCredentialApi.create(projectId, repoId, credentialName, credential), '凭证已保存并绑定到此仓库。');
    } else if (operation === 'rotate' && target) {
      void run(() => hubCredentialApi.rotate(projectId, repoId, credential, target.credentialId, target.version), '凭证已轮换，所有绑定将使用新版本。');
    }
  };

  if (availability === 'loading' || availability === 'hidden') return null;
  if (availability === 'error') return (
    <div className="mt-2 text-meta text-secondary" data-testid="hub-credential-load-error">
      Hub 托管凭证状态暂时无法加载。{' '}
      <button type="button" className="min-h-[44px] text-primary underline md:min-h-0" onClick={() => void load()}>重试</button>
    </div>
  );
  if (!details) return null;
  const binding = details.binding;
  return (
    <div className="mt-3 border-t border-hair pt-2" data-testid="hub-repo-credential">
      <div className="flex flex-wrap items-baseline gap-x-2 text-meta">
        <span className="text-primary">Hub 托管 · 读取仓库</span>
        <span className="text-tertiary">{binding ? `已绑定 ${binding.name} · 版本 ${binding.version}` : '尚未绑定'}</span>
      </div>
      <p className="mt-1 text-meta text-tertiary">由 Hub 代读远端快照，不更新本地文件；与上方机器流程的令牌分开配置。</p>
      {targetChanged ? <p className="mt-1 text-meta text-rust">仓库地址或分支有未保存的修改。请先保存，再管理或检查 Hub 凭证。</p> : null}
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="min-w-[12rem] flex-1 text-meta text-secondary">
          选择已有凭证
          <select className={`${INPUT} mt-0.5 w-full`} value={selected} disabled={busy || targetChanged} onChange={(event) => setSelected(event.target.value)}>
            <option value="">选择凭证</option>
            {details.credentials.map((item) => <option key={item.id} value={item.id}>{item.name} · 版本 {item.version}</option>)}
          </select>
        </label>
        <button type="button" className={SECONDARY_BUTTON} disabled={busy || targetChanged || !selected || selected === binding?.credentialId} onClick={() => void run(() => hubCredentialApi.bind(projectId, repoId, selected), '已绑定到此仓库。')}>绑定</button>
        <button type="button" className={SECONDARY_BUTTON} disabled={busy || targetChanged} onClick={() => { clearForm(); setError(''); setForm('create'); }}>新增并绑定</button>
      </div>
      {binding ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={SECONDARY_BUTTON} disabled={busy || targetChanged} onClick={() => void run(() => hubCredentialApi.check(projectId, repoId), (value) => {
            const result = value as HubCredentialCheck;
            if (result.status === 'ok') return `读取检查通过${result.branch ? ` · ${result.branch}` : ''} · ${new Date().toLocaleTimeString()}；仅代表此次检查，不代表可写。`;
            if (result.status === 'branch_missing') return `未找到${result.branch ? `分支 ${result.branch}` : '指定分支'}。`;
            return '暂时无法读取，请检查仓库配置或稍后重试。';
          })}>检查读取</button>
          <button type="button" className={SECONDARY_BUTTON} disabled={busy || targetChanged} onClick={() => { clearForm(); setError(''); setRotationTarget({ credentialId: binding.credentialId, version: binding.version, name: binding.name }); setForm('rotate'); }}>轮换凭证</button>
          <button type="button" className={SECONDARY_BUTTON} disabled={busy || targetChanged} onClick={() => {
            if (window.confirm('只解除此仓库的绑定，不删除共享凭证。确认解除？')) void run(() => hubCredentialApi.unbind(projectId, repoId), '已解除此仓库的绑定。');
          }}>解除绑定</button>
          <button type="button" className={SECONDARY_BUTTON} disabled={busy || targetChanged} onClick={() => {
            const target = { credentialId: binding.credentialId, version: binding.version, name: binding.name };
            if (window.confirm(`撤销「${target.name}」（版本 ${target.version}）会影响团队内所有使用这份凭证的仓库，且无法继续使用。确认撤销？`)) void run(() => hubCredentialApi.revoke(projectId, repoId, target.credentialId, target.version), '凭证已撤销。');
          }}>撤销共享凭证</button>
        </div>
      ) : null}
      {form ? (
        <div className="mt-2 rounded-sm border border-hair p-2" data-testid="hub-credential-form">
          <p className="text-meta text-secondary">{form === 'create' ? '新增只读凭证并绑定此仓库' : '轮换共享凭证 · 会影响所有绑定'}</p>
          {form === 'create' ? <label className="mt-2 block text-meta text-secondary">凭证名称<input className={`${INPUT} mt-0.5 w-full`} value={name} onChange={(event) => setName(event.target.value)} /></label> : null}
          <label className="mt-2 block text-meta text-secondary">凭证值<input ref={secretRef} className={`${INPUT} mt-0.5 w-full`} type="password" autoComplete="off" /></label>
          <p className="mt-1 text-meta text-tertiary">保存后不可查看；请使用同一外部身份的只读凭证。</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={SECONDARY_BUTTON} disabled={busy || targetChanged} onClick={submitSecret}>确认保存</button>
            <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={clearForm}>取消</button>
          </div>
        </div>
      ) : null}
      <p className="mt-1 text-meta text-secondary" aria-live="polite">{busy ? '处理中…' : error || (!targetChanged ? notice : '')}</p>
    </div>
  );
}
