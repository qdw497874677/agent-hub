import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, observeApi, type ObserveBranchDto, type ObserveNodeDto } from './api.ts';
import { formatRoute } from './route.ts';
import { AccountMenu } from './auth.tsx';

/**
 * 可观测（ADR 0033）。只渲染接口契约：实线是父子，虚线是链接。
 * 没有批准、取消、暂停。加载完成之前不说「还没有」。
 */
const time = (ms: number | null) => (ms === null ? '—' : new Date(ms).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
const spanText = (ms: number) => {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
};

function attr(node: ObserveNodeDto, key: string) {
  return node.attrs.find((item) => item.key === key)?.value ?? null;
}

function sessionHref(node: ObserveNodeDto) {
  const sessionId = attr(node, '会话');
  const projectId = attr(node, '项目');
  if (!sessionId || !projectId) return null;
  return formatRoute({ page: 'project', projectId, view: 'focus', sessionId });
}

export function ObservePage({ source, id }: { source: string | null; id: string | null }) {
  return (
    <div className="flex h-full flex-col md:flex-row">
      <nav className="flex w-full shrink-0 flex-col border-b border-hair px-3 py-4 md:w-[220px] md:border-b-0 md:border-r">
        <div className="mb-4 flex items-start justify-between gap-2">
          <div>
            <a className="text-head text-primary" href="#/home">agent-hub</a>
            <p className="mt-1 text-meta text-tertiary">自带机器与 agent 的工作台</p>
          </div>
          <AccountMenu />
        </div>
        <a className="rounded-sm bg-card px-2 py-1 text-body text-primary" href="#/observe" data-testid="nav-observe-here">可观测</a>
        <a className="mt-1 rounded-sm px-2 py-1 text-body text-secondary hover:bg-card" href="#/home">首页</a>
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        {source && id ? <ObserveDetail source={source} id={id} /> : <ObserveList />}
      </main>
    </div>
  );
}

function ObserveList() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [hours, setHours] = useState(24);
  const [projectId, setProjectId] = useState('');
  const [needsLook, setNeedsLook] = useState(false);
  const since = useMemo(() => Date.now() - hours * 60 * 60_000, [hours]);
  const list = useQuery({
    queryKey: ['observe', since, projectId, needsLook],
    queryFn: () => observeApi.list({ since, projectId: projectId || undefined, needsLook, source: 'connector', limit: 50 }),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000
  });
  return (
    <div data-testid="observe-page">
      <div className="mb-2 flex items-baseline gap-2">
        <h1 className="text-head text-primary">可观测</h1>
        <span className="text-meta text-tertiary">只读</span>
      </div>
      <p className="mb-3 text-meta text-secondary">点一行打开树。批准、取消、暂停仍在原来的页面。</p>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-meta">
        <label className="text-tertiary">时间
          <select className="ml-1 bg-transparent text-primary" data-testid="observe-window" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            <option value={24}>近 24 小时</option>
            <option value={24 * 7}>近 7 天</option>
          </select>
        </label>
        <label className="text-tertiary">项目
          <select className="ml-1 bg-transparent text-primary" data-testid="observe-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">全部</option>
            {(projects.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-secondary">
          <input type="checkbox" data-testid="observe-needs-look" checked={needsLook} onChange={(e) => setNeedsLook(e.target.checked)} />
          只看失败或缺环
        </label>
      </div>
      {list.isError ? (
        <p className="mb-2 text-meta text-rust" data-testid="observe-error">刷新失败 <button className="underline" onClick={() => void list.refetch()}>重试</button></p>
      ) : null}
      {list.isPending ? <div data-testid="observe-loading" className="h-24 rounded-md bg-card" /> : null}
      {list.data && !list.data.enabled ? <p data-testid="observe-disabled" className="text-meta text-tertiary">可观测未启用。触发和调度照常进行。</p> : null}
      {list.data?.enabled && list.data.items.length === 0 ? (
        <p data-testid="observe-empty" className="text-meta text-tertiary">还没有可显示的记录。<a className="text-accent" href="#/bots">去 Bot 页</a></p>
      ) : null}
      {list.data?.enabled && list.data.items.length > 0 ? (
        <table className="w-full border-collapse overflow-hidden rounded-md border border-hair bg-card" data-testid="observe-list">
          <thead>
            <tr className="border-b border-hair text-left text-meta text-tertiary">
              <th className="px-3 py-2 font-normal">时间</th>
              <th className="px-3 py-2 font-normal">来源</th>
              <th className="px-3 py-2 font-normal">标题</th>
              <th className="px-3 py-2 font-normal">状态</th>
              <th className="px-3 py-2 font-normal">缺口</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((item) => (
              <tr key={item.id} className="border-b border-hair last:border-b-0" data-testid="observe-row" data-state={item.nativeState}>
                <td className="px-3 py-2 text-meta text-tertiary">{time(item.at)}</td>
                <td className="px-3 py-2 text-body">{item.source === 'connector' ? '连接器' : item.source}</td>
                <td className="px-3 py-2 text-body">{item.title}</td>
                <td className="px-3 py-2 text-meta">{item.nativeStateLabel} <span className="text-tertiary">{item.nativeState}</span></td>
                <td className="px-3 py-2 text-meta text-secondary">{item.gap ?? '—'}</td>
                <td className="px-3 py-2 text-right"><a className="text-meta text-accent" href={formatRoute({ page: 'observe', source: item.source, id: item.id.slice(item.source.length + 1) })}>打开树</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {list.data?.truncated ? <p className="mt-2 text-meta text-tertiary">只显示最近的一批。更早的要缩小时间或项目。</p> : null}
    </div>
  );
}

function ObserveDetail({ source, id }: { source: string; id: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const detail = useQuery({
    queryKey: ['observe', source, id],
    queryFn: () => observeApi.get(source, id),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000
  });
  const tree = detail.data?.tree ?? null;
  const trace = detail.data?.trace ?? null;
  const picked = selected ?? trace?.headId ?? null;
  const node = trace?.nodes.find((item) => item.id === picked) ?? null;
  return (
    <div data-testid="observe-detail">
      <a className="text-meta text-accent" href="#/observe">← 列表</a>
      <h1 className="mt-1 text-head text-primary">{trace?.title ?? '链路'}</h1>
      {detail.isError ? <p className="mt-2 text-meta text-rust" data-testid="observe-error">刷新失败 <button className="underline" onClick={() => void detail.refetch()}>重试</button></p> : null}
      {detail.isPending ? <div data-testid="observe-loading" className="mt-3 h-24 rounded-md bg-card" /> : null}
      {detail.data && !detail.data.enabled ? <p data-testid="observe-disabled" className="mt-3 text-meta text-tertiary">可观测未启用。</p> : null}
      {tree && trace ? (
        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="rounded-md border border-hair bg-card p-2" data-testid="observe-tree">
            <p className="px-2 py-1 text-meta text-tertiary">实线是父子。虚线是链接，不是子调用。</p>
            {tree.roots.map((branch) => (
              <Branch key={branch.node.id} branch={branch} depth={0} selected={picked} closed={closed} onSelect={setSelected} onToggle={(nodeId) => setClosed((prev) => {
                const next = new Set(prev);
                if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
                return next;
              })} />
            ))}
            {tree.missingParent.length ? <p className="mt-2 px-2 text-meta text-tertiary">父级不在本页</p> : null}
            {tree.missingParent.map((item) => <NodeButton key={item.id} node={item} depth={0} selected={picked === item.id} edge="missing" onSelect={setSelected} />)}
            {tree.unlinked.length ? <p className="mt-2 px-2 text-meta text-tertiary">未关联</p> : null}
            {tree.unlinked.map((item) => <NodeButton key={item.id} node={item} depth={0} selected={picked === item.id} edge="none" onSelect={setSelected} />)}
            {tree.unrecorded.length ? <p className="mt-2 px-2 text-meta text-tertiary">未记录</p> : null}
            {tree.unrecorded.map((item) => <NodeButton key={item.id} node={item} depth={0} selected={picked === item.id} edge="none" onSelect={setSelected} />)}
          </div>
          <NodeDetail node={node} externalUrl={trace.externalUrl} />
        </div>
      ) : null}
    </div>
  );
}

function Branch({ branch, depth, selected, closed, onSelect, onToggle }: {
  branch: ObserveBranchDto; depth: number; selected: string | null; closed: ReadonlySet<string>;
  onSelect(id: string): void; onToggle(id: string): void;
}) {
  const folded = closed.has(branch.node.id);
  const hasKids = branch.children.length + branch.links.length > 0;
  return (
    <div>
      <NodeButton node={branch.node} depth={depth} selected={selected === branch.node.id} edge="parent" caret={hasKids ? (folded ? '▸' : '▾') : ''} onSelect={onSelect} onToggle={() => onToggle(branch.node.id)} />
      {folded ? null : (
        <>
          {branch.children.map((child) => <Branch key={child.node.id} branch={child} depth={depth + 1} selected={selected} closed={closed} onSelect={onSelect} onToggle={onToggle} />)}
          {branch.links.map((link) => (
            <div key={`${branch.node.id}:${link.branch.node.id}:${link.label}`}>
              <p className="text-meta text-tertiary" style={{ paddingLeft: 12 + depth * 16 }} data-testid="observe-link">{link.label}</p>
              <Branch branch={link.branch} depth={depth + 1} selected={selected} closed={closed} onSelect={onSelect} onToggle={onToggle} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function NodeButton({ node, depth, selected, edge, caret, onSelect, onToggle }: {
  node: ObserveNodeDto; depth: number; selected: boolean; edge: 'parent' | 'link' | 'missing' | 'none';
  caret?: string; onSelect(id: string): void; onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="observe-node"
      data-kind={node.kind}
      data-edge={edge}
      data-selected={selected ? '1' : '0'}
      className={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left ${selected ? 'bg-card-raised' : 'hover:bg-panel'}`}
      style={{ paddingLeft: 8 + depth * 16 }}
      onClick={() => { onToggle?.(); onSelect(node.id); }}
    >
      <span className="w-3 text-meta text-tertiary">{caret || (edge === 'link' ? '┄' : '')}</span>
      <span className="min-w-0 flex-1 truncate text-body">{node.name}</span>
      <span className="shrink-0 text-meta text-secondary">{node.stateLabel ?? (node.kind === 'sink' ? '未记录' : node.state ?? '')}</span>
      {node.durationLabel && node.durationMs !== null ? <span className="shrink-0 text-meta text-tertiary">{node.durationLabel} {spanText(node.durationMs)}</span> : null}
    </button>
  );
}

function NodeDetail({ node, externalUrl }: { node: ObserveNodeDto | null; externalUrl: string | null }) {
  if (!node) return <aside className="rounded-md border border-hair bg-card p-3 text-meta text-tertiary" data-testid="observe-detail-empty">选一个节点</aside>;
  const href = sessionHref(node);
  const projectId = attr(node, '定义项目');
  return (
    <aside className="rounded-md border border-hair bg-card p-3" data-testid="observe-node-detail">
      <h2 className="text-head text-primary">{node.name}</h2>
      <p className="text-meta text-tertiary">{node.kind}{node.state ? ` · ${node.state}` : ''}</p>
      <dl className="mt-2 space-y-2">
        <div><dt className="text-meta text-tertiary">开始 / 结束</dt><dd className="text-body">{time(node.startedAt)} → {time(node.endedAt)}</dd></div>
        <div><dt className="text-meta text-tertiary">耗时</dt><dd className="text-body">{node.durationLabel && node.durationMs !== null ? `${node.durationLabel} ${spanText(node.durationMs)}` : '无耗时'}</dd></div>
        {node.attrs.map((item) => (
          <div key={item.key}><dt className="text-meta text-tertiary">{item.key}</dt><dd className="break-all text-body">{item.value}</dd></div>
        ))}
      </dl>
      {href ? <a className="mt-3 inline-block text-meta text-accent" href={href}>打开会话</a> : null}
      {projectId ? <a className="mt-3 ml-3 inline-block text-meta text-accent" href={formatRoute({ page: 'bots', projectId })}>Bot 页</a> : null}
      {externalUrl ? <a className="mt-3 block text-meta text-accent" href={externalUrl}>在外部打开</a> : null}
      <p className="mt-3 text-meta text-tertiary">这里不能批准、取消或重试。</p>
    </aside>
  );
}
