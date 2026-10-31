import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type CatalogComponentDto } from '../api.ts';
import { at, errorText, Empty, INPUT, Panel, Section, SMALL, DANGER, useAdminAction } from './shared.tsx';

/** 安装脚本里值得多看一眼的片段：联网下载、提权、管道执行、删文件。只是提示，不替审核人判断。 */
const RISKY = /(curl|wget|sudo|\|\s*(?:ba)?sh\b|eval|chmod|chown|rm\s+-rf|node\s+-e|https?:\/\/\S+)/g;

function highlight(text: string) {
  const parts = text.split(RISKY).filter((part) => part !== '');
  const one = new RegExp(RISKY.source);
  return parts.map((part, index) =>
    one.test(part) ? (
      <mark key={index} className="rounded-sm bg-rust/20 px-0.5 text-rust" data-testid="script-risky">
        {part}
      </mark>
    ) : (
      <span key={index}>{part}</span>
    )
  );
}

/** 与上一版已批准的比：新增 / 变了 / 没变。审核人最该看的是变化。 */
export function scriptDiff(item: CatalogComponentDto, previous: CatalogComponentDto | undefined) {
  return Object.entries(item.scripts).map(([name, body]) => {
    const before = previous?.scripts[name];
    const change = !previous ? 'new' : before === undefined ? 'new' : before === body ? 'same' : 'changed';
    return { name, body, before, change } as const;
  });
}

function previousApproved(all: readonly CatalogComponentDto[], item: CatalogComponentDto) {
  return all
    .filter((c) => c.id === item.id && c.version !== item.version && c.status === 'approved' && c.submittedAt < item.submittedAt)
    .sort((a, b) => b.submittedAt - a.submittedAt)[0];
}

const STATUS: Record<CatalogComponentDto['status'], string> = { pending: '待审核', approved: '已批准', rejected: '已拒绝' };

function Item({ item, all }: { item: CatalogComponentDto; all: readonly CatalogComponentDto[] }) {
  const [note, setNote] = useState('');
  const review = useAdminAction((approve: boolean) => api.reviewComponent(item.id, item.version, approve, note.trim() || undefined));
  const previous = previousApproved(all, item);
  const scripts = scriptDiff(item, previous);
  const removed = previous ? Object.keys(previous.scripts).filter((name) => !(name in item.scripts)) : [];
  return (
    <li className="min-w-0 border-b border-hair px-3 py-3 last:border-b-0" data-testid="component-item">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-body text-primary break-all">{item.id}</span>
        <span className="text-meta text-secondary">v{item.version}</span>
        <span
          data-testid="component-status"
          className={`rounded-sm border px-1 text-xs ${item.status === 'pending' ? 'border-accent text-accent' : item.status === 'rejected' ? 'border-rust text-rust' : 'border-hair text-tertiary'}`}
        >
          {STATUS[item.status]}
        </span>
      </div>
      <p className="mt-1 break-all text-meta text-tertiary">
        npm：<span className="font-mono">{item.packageName}@{item.version}</span> · 依赖 {item.dependencyCount} 个 · 提交 {item.submittedBy} {at(item.submittedAt)}
      </p>
      <p className="break-all font-mono text-[11px] text-tertiary">{item.integrity}</p>
      {item.provides.length ? <p className="text-meta text-secondary">能力：{item.provides.map((p) => p.capability).join('、')}</p> : null}
      <div className="mt-2" data-testid="component-scripts">
        {scripts.length === 0 ? (
          <p className="text-meta text-tertiary">顶层包没有安装脚本{item.dependencyCount > 0 ? '（依赖里的脚本装的时候也会跑，会逐条记审计）' : ''}</p>
        ) : (
          <>
            <p className="text-meta text-rust">
              ⚠ 带安装脚本：Worker 会用非 root 身份运行，每条都记审计；hub 设置里可以一键禁止所有安装脚本。
              {previous ? ` 与已批准的 v${previous.version} 对比：` : ''}
            </p>
            {scripts.map((script) => (
              <div key={script.name} className="mt-1 min-w-0 rounded-sm border border-hair" data-testid={`script-${script.change}`}>
                <p className="border-b border-hair px-2 py-0.5 text-xs text-secondary">
                  {script.name}
                  {script.change === 'new' ? <span className="ml-1 text-rust">新增</span> : script.change === 'changed' ? <span className="ml-1 text-rust">有变化</span> : <span className="ml-1 text-tertiary">没变</span>}
                </p>
                {script.change === 'changed' && script.before !== undefined ? (
                  <pre className="overflow-x-auto whitespace-pre-wrap break-all px-2 py-1 font-mono text-[11px] text-tertiary line-through">{script.before}</pre>
                ) : null}
                <pre className="overflow-x-auto whitespace-pre-wrap break-all px-2 py-1 font-mono text-[11px] text-primary">{highlight(script.body)}</pre>
              </div>
            ))}
          </>
        )}
        {removed.length ? <p className="text-meta text-tertiary">去掉了：{removed.join('、')}</p> : null}
      </div>
      {item.reviewNote ? <p className="mt-1 text-meta text-tertiary">审核意见：{item.reviewNote}（{item.reviewedBy}）</p> : null}
      {item.status === 'pending' ? (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input className={INPUT} placeholder="审核意见（可选）" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          <div className="flex shrink-0 gap-2">
            <button className={SMALL} data-testid="component-approve" disabled={review.isPending} onClick={() => review.mutate(true)}>
              批准
            </button>
            <button className={DANGER} data-testid="component-reject" disabled={review.isPending} onClick={() => review.mutate(false)}>
              拒绝
            </button>
          </div>
        </div>
      ) : null}
      {review.error ? <p role="alert" className="mt-1 text-meta text-rust">{errorText(review.error)}</p> : null}
    </li>
  );
}

function SubmitForm() {
  const [id, setId] = useState('');
  const [packageName, setPackageName] = useState('');
  const [version, setVersion] = useState('');
  const [caps, setCaps] = useState('');
  const submit = useAdminAction(() =>
    api.submitComponent({
      id: id.trim(),
      packageName: packageName.trim(),
      version: version.trim(),
      provides: caps.split(/[,，\s]+/).filter(Boolean).map((capability) => ({ capability }))
    })
  );
  return (
    <form
      className="grid grid-cols-1 gap-2 px-3 py-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit.mutate(undefined, { onSuccess: () => (setId(''), setPackageName(''), setVersion(''), setCaps('')) });
      }}
    >
      <input className={INPUT} data-testid="component-id" placeholder="组件 id，如 web-search" value={id} onChange={(e) => setId(e.target.value)} required />
      <input className={INPUT} data-testid="component-package" placeholder="npm 包名" value={packageName} onChange={(e) => setPackageName(e.target.value)} required />
      <input className={INPUT} data-testid="component-version" placeholder="确切版本，如 1.2.3" value={version} onChange={(e) => setVersion(e.target.value)} required />
      <input className={INPUT} data-testid="component-caps" placeholder="提供的能力，如 tool:web-search（逗号分隔）" value={caps} onChange={(e) => setCaps(e.target.value)} />
      <div className="flex items-center gap-2 sm:col-span-2">
        <button className={`${SMALL} shrink-0 whitespace-nowrap`} data-testid="component-submit" disabled={submit.isPending} type="submit">
          {submit.isPending ? '查 registry…' : '提交审核'}
        </button>
        <span className="text-meta text-tertiary">hub 会先去 registry 解析并钉死这个版本的制品哈希，审的就是装的。</span>
      </div>
      {submit.error ? <p role="alert" className="text-meta text-rust sm:col-span-2">{errorText(submit.error)}</p> : null}
    </form>
  );
}

/** 组件目录（ADR 0021 §8）：第三方组件要 cluster_admin 审过才能装到机器上。 */
export function Components() {
  const list = useQuery({ queryKey: ['admin', 'components'], queryFn: api.components });
  const items = [...(list.data ?? [])].sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.submittedAt - a.submittedAt);
  return (
    <>
      <Section title="提交组件">
        <Panel>
          <SubmitForm />
        </Panel>
      </Section>
      <Section title="组件目录">
        <Panel>
          {list.isLoading ? <Empty text="载入中…" /> : items.length === 0 ? <Empty text="目录是空的" /> : (
            <ul data-testid="component-list">
              {items.map((item) => (
                <Item key={`${item.id}@${item.version}`} item={item} all={items} />
              ))}
            </ul>
          )}
        </Panel>
      </Section>
    </>
  );
}
