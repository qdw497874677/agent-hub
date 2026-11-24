import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, observeApi, type ObserveBranchDto, type ObserveNodeDto } from './api.ts';
import { RequestFailed } from './api/http.ts';
import { formatRoute } from './route.ts';
import { AppShell, PageBody, PageHeader } from './page-shell.tsx';

/**
 * 可观测（ADR 0033）。只渲染接口契约：实线是父子，虚线是链接。
 * 没有批准、取消、暂停。加载完成之前不说「还没有」。
 *
 * 来源由适配器决定，界面不替它们编名字。默认把所有已注册的来源放在一起；
 * 显式选一个来源时再把 source 传给接口。
 */
const time = (ms: number | null) => {
  if (ms === null) return '—';
  const at = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  // 固定 24 小时、不带 AM/PM：手机上时间列不至于折成三行。
  return `${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
};
const spanText = (ms: number) => {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
};

// 证据的记录时间是一个时间点，不是执行的起止或耗时。
const recordedTime = (value: string) => {
  if (!/^\d+$/.test(value)) return '未记录';
  const at = new Date(Number(value));
  if (Number.isNaN(at.getTime())) return '未记录';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};

const SOURCE_LABEL: Record<string, string> = { connector: '连接器', agent: 'Agent 回合', dispatch: '调度', delegation: '派工', message: '会话通信', machine: '机器连接' };
const SOURCE_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: '全部' },
  { value: 'agent', label: 'Agent 回合' },
  { value: 'connector', label: '连接器' },
  { value: 'dispatch', label: '调度' },
  { value: 'delegation', label: '派工' },
  { value: 'message', label: '会话通信' },
  { value: 'machine', label: '机器连接' }
];

/** 原生状态只做兜底翻译：适配器给了中文 stateLabel 就用它的。 */
const STATE_LABEL: Record<string, string> = {
  queued: '排队中',
  sending: '发送中',
  delivered: '已送达',
  undelivered: '未送达',
  cancelled: '已撤回',
  held: '挂起',
  waiting: '等待中',
  posted: '已入群',
  posting: '入群中',
  prepared: '已准备',
  done: '完成',
  failed: '失败',
  timeout: '超时',
  skipped: '跳过',
  running: '运行中',
  stopped: '已停止',
  interrupted: '中断',
  ready: '就绪',
  pending: '等待中',
  approved: '已批准',
  denied: '已拒绝',
  none: '无'
};

const KIND_LABEL: Record<string, string> = {
  trigger: '触发',
  task_request: '任务请求',
  task: '任务',
  dispatch: '调度',
  delegation: '派工',
  'delegation-acceptance': '验收记录',
  'delegation-publish-attempt': '发布尝试',
  machine_connection: '机器连接',
  machine_install_report: '安装报告',
  session: '会话',
  delivery: '送达',
  sink: '回写',
  turn: 'Agent 回合',
  turn_end: '回合结束',
  first_output: '首条输出',
  message: '消息',
  reply: '回复',
  tool: '工具调用',
  model: '模型调用',
  error: '错误'
};

const sourceLabel = (source: string) => SOURCE_LABEL[source] ?? source;
const kindLabel = (kind: string, source: string) => source === 'agent' && kind === 'sink' ? '回合结果' : KIND_LABEL[kind] ?? kind;

/** 状态文案：中文 stateLabel 优先，其次翻译原生状态；都没有就返回 null（由调用方决定怎么诚实表达）。 */
function stateText(state: string | null, label: string | null): string | null {
  if (label && STATE_LABEL[label]) return STATE_LABEL[label];
  if (label) return label;
  if (state && STATE_LABEL[state]) return STATE_LABEL[state];
  return state || null;
}

const unavailable = (error: unknown, includeNotFound = false) => error instanceof RequestFailed
  && (error.status === 401 || error.status === 403 || (includeNotFound && error.status === 404));

/** 列表主列：只说状态，不再重复贴原生英文。 */
const listStateText = (item: { nativeState: string; nativeStateLabel: string }) => stateText(item.nativeState, item.nativeStateLabel) ?? '—';

const emptyText = (source: string) => {
  if (source === 'agent') return '没有 Agent 回合记录。';
  if (source === 'connector') return '没有连接器记录。';
  if (source === 'dispatch') return '没有调度记录。';
  if (source === 'delegation') return '没有派工记录。';
  if (source === 'message') return '没有会话通信记录。';
  if (source === 'machine') return '没有机器连接记录。';
  return '没有记录。';
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
    <AppShell>
      <PageHeader
        title={source && id ? '链路' : '运行记录'}
        parent={source && id ? { label: '运行记录', href: '#/observe' } : undefined}
      />
      <PageBody wide>
        {source && id ? <ObserveDetail key={`${source}:${id}`} source={source} id={id} /> : <ObserveList />}
      </PageBody>
    </AppShell>
  );
}

function ObserveList() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [hours, setHours] = useState(24);
  const [source, setSource] = useState('');
  const [projectId, setProjectId] = useState('');
  const [needsLook, setNeedsLook] = useState(false);
  const since = useMemo(() => Date.now() - hours * 60 * 60_000, [hours]);
  const list = useQuery({
    queryKey: ['observe', since, source, projectId, needsLook],
    queryFn: () => observeApi.list({ since, projectId: projectId || undefined, needsLook, source: source || undefined, limit: 50 }),
    gcTime: 0,
    refetchOnMount: 'always',
    retry: false,
    refetchInterval: 10_000
  });
  // 每次刷新都等新的响应；错误、换筛选或重新挂载时不展示缓存，避免权限变化后旧数据复现。
  const accessLost = unavailable(list.error);
  const data = list.isError || list.isFetching ? undefined : list.data;
  const items = data?.items ?? [];
  const mixed = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
    return counts.size > 1 ? [...counts.entries()].map(([key, count]) => `${sourceLabel(key)} ${count}`).join(' · ') : null;
  }, [items]);
  return (
    <div data-testid="observe-page" className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-meta">
        <label className="text-tertiary">来源
          <select className="ml-1 bg-transparent text-primary" data-testid="observe-source" value={source} onChange={(e) => setSource(e.target.value)}>
            {SOURCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
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
      {projectId && (source === '' || source === 'machine') ? <p data-testid="observe-machine-project-note" className="mb-2 text-meta text-tertiary">机器连接记录不属于项目；选择项目时不会显示。清除项目筛选后可按其他条件查看。</p> : null}
      {list.isError && !list.isFetching ? (
        <p className="mb-2 text-meta text-rust" data-testid="observe-error">{accessLost ? '无法查看运行记录，请检查登录状态或访问权限。' : '刷新失败'} <button className="underline" onClick={() => void list.refetch()}>重试</button></p>
      ) : null}
      {list.isFetching ? <div data-testid="observe-loading" role="status" aria-label="正在加载运行记录" className="h-24 rounded-md bg-card" /> : null}
      {data && !data.enabled ? <p data-testid="observe-disabled" className="text-meta text-tertiary">运行记录未启用。触发和调度照常进行。</p> : null}
      {data?.viewer === 'anonymous' ? (
        <p data-testid="observe-anonymous" className="mb-2 text-meta text-rust">没有登录。开了账号权限时这里不列出记录，这不是「没有数据」。</p>
      ) : null}
      {mixed ? <p className="mb-2 text-meta text-tertiary" data-testid="observe-mixed">本页混合来源：{mixed}</p> : null}
      {data?.enabled && data.viewer !== 'anonymous' && items.length === 0 ? (
        <p data-testid="observe-empty" className="text-meta text-tertiary">{data.truncated ? '已扫描的范围内没有匹配记录。' : emptyText(source)}{!data.truncated && source === 'connector' ? <a className="text-link" href="#/bots">查看 Bot</a> : null}</p>
      ) : null}
      {data?.enabled && data.viewer !== 'anonymous' && items.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-hair bg-card">
          <table className="w-full table-fixed border-collapse" data-testid="observe-list" aria-busy={list.isFetching}>
            <thead>
              <tr className="border-b border-hair text-left text-meta text-tertiary">
                <th className="w-[88px] px-2 py-2 font-normal sm:w-[112px] sm:px-3">时间</th>
                <th className="hidden px-3 py-2 font-normal sm:table-cell sm:w-[88px]">来源</th>
                <th className="px-2 py-2 font-normal sm:px-3">标题</th>
                <th className="w-[72px] px-2 py-2 font-normal sm:w-[104px] sm:px-3">状态</th>
                <th className="hidden px-3 py-2 font-normal sm:table-cell sm:w-[128px]">缺口</th>
                <th className="w-[56px] px-2 py-2 font-normal sm:w-[76px] sm:px-3"><span className="sr-only">详情</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-hair align-top last:border-b-0" data-testid="observe-row" data-source={item.source} data-state={item.nativeState}>
                  <td className="px-2 py-2 text-meta leading-tight text-tertiary sm:px-3">{time(item.at)}</td>
                  <td className="hidden px-3 py-2 text-body sm:table-cell">{sourceLabel(item.source)}</td>
                  <td className="min-w-0 px-2 py-2 sm:px-3">
                    <div className="truncate text-body text-primary" title={item.title}>{item.title}</div>
                    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta text-tertiary sm:hidden">
                      <span className="shrink-0">{sourceLabel(item.source)}</span>
                      {item.gap ? <span className="min-w-0 text-warning">缺口：{item.gap}</span> : null}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-meta sm:px-3">
                    <span className={item.gap ? 'text-warning' : 'text-secondary'}>{listStateText(item)}</span>
                  </td>
                  <td className="hidden px-3 py-2 text-meta sm:table-cell">
                    <span className={item.gap ? 'text-warning' : 'text-secondary'}>{item.gap ?? '—'}</span>
                  </td>
                  <td className="px-2 py-2 text-right sm:px-3">
                    <a className="text-meta text-link" href={formatRoute({ page: 'observe', source: item.source, id: item.id.slice(item.source.length + 1) })}>打开树</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data?.enabled && data.viewer !== 'anonymous' && data.truncated ? (
        <p
          className="mt-2 text-meta text-warning"
          data-testid="observe-scan"
          data-truncated="1"
        >
          当前时间范围内的结果可能不完整：部分记录未被扫描或未显示。
        </p>
      ) : null}
    </div>
  );
}

function ObserveDetail({ source, id }: { source: string; id: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const detail = useQuery({
    queryKey: ['observe', source, id],
    queryFn: () => observeApi.get(source, id),
    // 不保留上一条记录的树：换了记录就先给加载态，别把另一条链路当成本条。
    refetchInterval: 10_000,
    gcTime: 0,
    refetchOnMount: 'always',
    retry: false
  });
  const accessLost = unavailable(detail.error, true);
  const data = detail.isError || detail.isFetching ? undefined : detail.data;
  const tree = data?.tree ?? null;
  const trace = data?.trace ?? null;
  const picked = selected ?? trace?.headId ?? null;
  const node = trace?.nodes.find((item) => item.id === picked) ?? null;
  return (
    <div data-testid="observe-detail" className="min-w-0" aria-busy={detail.isFetching}>
      <p className="text-meta text-tertiary" data-testid="observe-detail-source">{sourceLabel(source)} · 只读</p>
      <h2 className="text-head text-primary">{trace?.title ?? '链路'}</h2>
      {detail.isError && !detail.isFetching ? <p className="mt-2 text-meta text-rust" data-testid="observe-error">{accessLost ? '没有可查看的这条记录。' : '加载失败。'} <button className="underline" onClick={() => void detail.refetch()}>重试</button></p> : null}
      {detail.isFetching ? <div data-testid="observe-loading" role="status" aria-label="正在加载链路" className="mt-3 h-24 rounded-md bg-card" /> : null}
      {data && !data.enabled ? <p data-testid="observe-disabled" className="mt-3 text-meta text-tertiary">运行记录未启用。</p> : null}
      {tree && trace ? (
        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 rounded-md border border-hair bg-card p-2" data-testid="observe-tree">
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
          <NodeDetail node={node} externalUrl={trace.externalUrl} source={source} />
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

/** 节点状态：有中文标签用中文；没有证据就写「未记录」，不把排队说成缺失。 */
const nodeStateText = (node: ObserveNodeDto) => stateText(node.state, node.stateLabel) ?? '未记录';

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
      <span className="shrink-0 text-meta text-secondary">{nodeStateText(node)}</span>
      {node.durationLabel && node.durationMs !== null ? <span className="shrink-0 text-meta text-tertiary">{node.durationLabel} {spanText(node.durationMs)}</span> : null}
    </button>
  );
}

function NodeDetail({ node, externalUrl, source }: { node: ObserveNodeDto | null; externalUrl: string | null; source: string }) {
  if (!node) return <aside className="min-w-0 rounded-md border border-hair bg-card p-3 text-meta text-tertiary" data-testid="observe-detail-empty">选一个节点</aside>;
  const href = sessionHref(node);
  const projectId = attr(node, '定义项目');
  const state = stateText(node.state, node.stateLabel);
  const evidence = node.kind === 'delegation-acceptance' || node.kind === 'delegation-publish-attempt';
  return (
    <aside className="min-w-0 rounded-md border border-hair bg-card p-3" data-testid="observe-node-detail">
      <h2 className="text-head text-primary">{node.name}</h2>
      <p className="text-meta text-tertiary">{kindLabel(node.kind, source)}{state ? ` · ${state}` : ''}</p>
      <dl className="mt-2 space-y-2">
        {!evidence ? <><div><dt className="text-meta text-tertiary">开始 / 结束</dt><dd className="text-body">{time(node.startedAt)} → {time(node.endedAt)}</dd></div>
        <div><dt className="text-meta text-tertiary">耗时</dt><dd className="text-body">{node.durationLabel && node.durationMs !== null ? `${node.durationLabel} ${spanText(node.durationMs)}` : '无耗时'}</dd></div></> : null}
        {node.attrs.map((item) => (
          <div key={item.key}><dt className="text-meta text-tertiary">{item.key}</dt><dd className="break-all text-body">{evidence && item.key === '记录时间' ? recordedTime(item.value) : item.value}</dd></div>
        ))}
      </dl>
      {href ? <a className="mt-3 inline-block text-meta text-link" href={href}>打开会话</a> : null}
      {projectId ? <a className="mt-3 ml-3 inline-block text-meta text-link" href={formatRoute({ page: 'bots', projectId })}>Bot 页</a> : null}
      {externalUrl ? <a className="mt-3 block text-meta text-link" href={externalUrl}>在外部打开</a> : null}
      <p className="mt-3 text-meta text-tertiary">这里不能批准、取消或重试。</p>
    </aside>
  );
}
