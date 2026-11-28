import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { developmentServicesApi, type DevelopmentService } from '../../shell/api/development-services.ts';
import { previewFeedbackPath, safePreviewUrl } from '../../atoms/preview-workflow-model.ts';
import { developmentManualPort, developmentServiceLabels, orderDevelopmentWorkers } from '../../atoms/development-service-model.ts';
import { DevelopmentLaunchScope, useDevelopmentLaunch } from '../../atoms/development-service-launch.ts';
import { Sheet } from '../../shell/dialog-shell.tsx';
import { useNarrow } from '../../shell/device.ts';

interface ReferenceHandler { workspaceId: string; sessionId: string; append: (id: string) => void }
interface ContextValue { open: boolean; setOpen: (open: boolean) => void; register: (handler: ReferenceHandler | null) => void; workspaceId?: string | null }
const Context = createContext<ContextValue | null>(null);
export const useDevelopmentServices = () => useContext(Context);

export function DevelopmentServicesHost({ accountId, workspaceId, workspacePath, workerId, sessionId, children }: { accountId: string; workspaceId?: string | null; workspacePath?: string | null; workerId?: string | null; sessionId?: string | null; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [handler, setHandler] = useState<ReferenceHandler | null>(null);
  const register = useCallback((value: ReferenceHandler | null) => setHandler(value), []);
  useEffect(() => { setOpen(false); }, [accountId, workspaceId, workerId]);
  const onReference = handler && handler.workspaceId === workspaceId && handler.sessionId === sessionId ? handler.append : undefined;
  return <DevelopmentLaunchScope.Provider value={JSON.stringify([accountId, workspaceId, workerId])}><Context.Provider value={{ open, setOpen, register, workspaceId }}><div className="flex min-h-0 min-w-0 flex-1">{children}{open ? <DevelopmentServicesPanel key={`${accountId}:${workspaceId}:${workerId}`} accountId={accountId} workspaceId={workspaceId} workspacePath={workspacePath} workerId={workerId} onReference={onReference} onClose={() => setOpen(false)} /> : null}</div></Context.Provider></DevelopmentLaunchScope.Provider>;
}
export function DevelopmentServicesButton() {
  const context = useDevelopmentServices();
  if (!context) return null;
  return <button type="button" data-testid="development-services-trigger" aria-expanded={context.open} onClick={() => context.setOpen(!context.open)} onPointerDown={(event) => event.stopPropagation()} className="min-h-[44px] shrink-0 rounded-sm px-2 text-meta text-sage hover:bg-hover">开发服务</button>;
}
function DevelopmentServicesPanel({ accountId, workspaceId, workspacePath, workerId, onReference, onClose }: { accountId: string; workspaceId?: string | null; workspacePath?: string | null; workerId?: string | null; onReference?: (id: string) => void; onClose: () => void }) {
  const narrow = useNarrow();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(workerId ? [workerId] : []));
  const [opening, setOpening] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [port, setPort] = useState('');
  const [path, setPath] = useState('/');
  const [manualOpen, setManualOpen] = useState(false);
  const launch = useDevelopmentLaunch();
  const workers = useQuery({ queryKey: ['development-services', accountId, 'workers'], queryFn: developmentServicesApi.workers, retry: false, staleTime: 0, refetchInterval: 15000 });
  const list = orderDevelopmentWorkers(workers.isError ? [] : workers.data?.workers ?? [], workerId);
  const details = useQueries({ queries: list.map((worker) => ({ queryKey: ['development-services', accountId, 'worker', worker.id], queryFn: () => developmentServicesApi.worker(worker.id), enabled: expanded.has(worker.id) && worker.state === 'online', retry: false, staleTime: 0, refetchInterval: expanded.has(worker.id) && worker.state === 'online' ? 15000 : false })) });
  const currentIndex = list.findIndex((worker) => worker.id === workerId);
  const currentWorker = list[currentIndex];
  const currentDetail = details[currentIndex];
  const manualAvailable = !!workerId && expanded.has(workerId) && currentWorker?.state === 'online' && !currentDetail?.isError && currentDetail?.data?.state === 'ready' && currentDetail.data.manualAvailable === true;
  async function openService(service: DevelopmentService) {
    if (!service.id || opening) return;
    setOpening(service.id); setNotice('');
    // Open a blank window synchronously so browser popup blockers do not suppress it.
    const request = launch();
    const popup = request.popup;
    try {
      const result = await developmentServicesApi.open(service.id);
      if (!request.active()) return;
      const url = result.state === 'ready' ? safePreviewUrl(result.url) : null;
      if (url && popup) popup.location.replace(url);
      else { popup?.close(); setNotice(result.state === 'pending' ? '服务正在准备，请稍后重新确认。' : url ? '浏览器阻止了打开新窗口。' : '服务地址暂不可用。'); }
    } catch { if (request.active()) { popup?.close(); setNotice('打开结果未确认，请重新查看服务状态后再操作。'); } }
    finally { if (request.active()) setOpening(null); request.finish(); }
  }
  async function openManual() {
    const numericPort = developmentManualPort(port);
    const safePath = previewFeedbackPath(path);
    if (!workspaceId || !workerId || !manualAvailable || opening) return;
    if (numericPort === null || safePath === null) { setNotice('请输入 1024–65535 的端口和以单个 / 开头的页面路径。'); return; }
    setOpening('manual'); setNotice('');
    const request = launch();
    const popup = request.popup;
    try {
      const result = await developmentServicesApi.manual(workerId, workspaceId, numericPort, safePath);
      if (!request.active()) return;
      const base = result.state === 'ready' ? safePreviewUrl(result.url) : null;
      if (base && popup) popup.location.replace(base);
      else { popup?.close(); setNotice(result.state === 'pending' ? '服务正在准备，请查看服务状态后手动确认。' : base ? '浏览器阻止了打开新窗口。' : '服务地址暂不可用。'); }
    } catch { if (request.active()) { popup?.close(); setNotice('打开结果未确认，请查看服务状态后手动确认。'); } }
    finally { if (request.active()) setOpening(null); request.finish(); }
  }
  const content = <div className="min-h-0 overflow-y-auto p-4" data-testid="development-services-content">
    <div className="mb-3 flex items-center justify-between gap-2"><p className="text-meta text-tertiary">所有机器 · 按工作目录查看</p><button type="button" data-testid="development-services-refresh" className="min-h-[44px] min-w-[44px] text-meta text-link" onClick={() => { void workers.refetch(); details.forEach((detail, index) => { if (expanded.has(list[index]!.id) && list[index]!.state === 'online') void detail.refetch(); }); }}>刷新</button></div>
    {workers.isPending ? <p role="status" className="text-sub text-tertiary">正在读取机器…</p> : workers.isError ? <div role="alert" className="text-sub text-secondary">机器读取失败 <button className="min-h-[44px] text-link" onClick={() => void workers.refetch()}>重试</button></div> : !list.length ? <p className="text-sub text-tertiary">没有可访问的机器</p> : list.map((worker, index) => {
      const isOpen = expanded.has(worker.id), detail = details[index];
      const groups = [...(detail?.data?.groups ?? [])].sort((a, b) => Number(b.workspaceId === workspaceId && !!workspaceId) - Number(a.workspaceId === workspaceId && !!workspaceId) || Number(a.workspaceId === null) - Number(b.workspaceId === null));
      return <section key={worker.id} className="border-t border-hair" data-testid="development-services-worker" data-worker-id={worker.id}>
        <button type="button" data-testid="development-services-worker-toggle" aria-expanded={isOpen} className="flex min-h-[52px] w-full items-center gap-2 text-left" onClick={() => setExpanded((old) => { const next = new Set(old); if (next.has(worker.id)) next.delete(worker.id); else next.add(worker.id); return next; })}><span aria-hidden>{isOpen ? '⌄' : '›'}</span><span className="min-w-0 flex-1 truncate text-sub text-primary" title={worker.name}>{worker.name}</span>{worker.id === workerId ? <span className="shrink-0 text-meta text-sage">当前机器</span> : null}<span className="shrink-0 text-meta text-tertiary">{worker.state === 'offline' ? '离线' : '在线'}</span></button>
        {isOpen ? <div className="pb-3 pl-4">{worker.state === 'offline' ? <p className="text-meta text-tertiary">机器离线，暂时无法查看服务。</p> : detail?.isPending ? <p role="status" className="text-meta text-tertiary">正在读取服务…</p> : detail?.isError ? <p role="alert" className="text-meta text-secondary">服务读取失败 <button className="min-h-[44px] text-link" onClick={() => void detail.refetch()}>重试</button></p> : detail?.data?.state === 'offline' ? <p className="text-meta text-tertiary">机器离线，暂时无法查看服务。</p> : detail?.data?.state === 'unavailable' ? <p className="text-meta text-tertiary">此机器暂不支持开发服务。</p> : !groups.length ? <p className="text-meta text-tertiary">没有发现开发服务。</p> : groups.map((group, i) => <div key={group.workspaceId ?? `unassigned-${i}`} data-testid="development-services-group" data-workspace-id={group.workspaceId ?? ''} className="mb-3"><div className="mb-1 flex min-w-0 items-center gap-2 text-meta text-secondary"><span className="truncate" title={group.name}>{group.workspaceId === null ? '未归属工作目录' : group.name}</span>{group.workspaceId && group.workspaceId === workspaceId ? <span className="shrink-0 text-sage">当前工作目录</span> : null}</div>{group.services.length === 0 ? <p className="text-meta text-tertiary">没有发现开发服务。</p> : group.services.map((service, j) => { const labels = developmentServiceLabels(service); return <div key={service.id ?? `${service.port}:${j}`} className="flex min-w-0 items-center gap-2 rounded border border-hair bg-card px-3 py-1"><div className="min-w-0 flex-1"><p className="truncate text-sub text-primary" title={labels.title}>{labels.title}</p>{labels.subtitle ? <p className="text-meta text-tertiary">{labels.subtitle}</p> : null}</div>{group.workspaceId !== null && service.id && service.openable ? <button type="button" data-testid="development-service-open" data-service-id={service.id} disabled={!!opening} className="min-h-[44px] min-w-[44px] shrink-0 px-1 text-meta text-link disabled:opacity-50" onClick={() => void openService(service)}>打开 ↗</button> : null}{group.workspaceId === workspaceId && service.id && onReference ? <button type="button" data-testid="development-service-reference" className="min-h-[44px] min-w-[44px] shrink-0 px-1 text-meta text-link" onClick={() => { onReference(service.id!); onClose(); }}>引用</button> : null}</div>; })}</div>)}</div> : null}
      </section>;
    })}
    {workspaceId && workerId ? <section className="mt-4 border-t border-hair pt-2">{manualAvailable ? <><button type="button" aria-expanded={manualOpen} data-testid="development-service-manual-toggle" className="min-h-[44px] text-left text-sub text-link" onClick={() => setManualOpen(!manualOpen)}>手动输入端口 {manualOpen ? '⌃' : '⌄'}</button>{manualOpen ? <div className="space-y-2"><p className="break-all text-meta text-tertiary">只检查当前工作目录 {workspacePath ?? workspaceId} 在其所属机器上可确认的监听端口，不支持任意主机。</p><label className="block text-meta text-secondary">端口<input data-testid="development-service-manual-port" type="number" min="1024" max="65535" value={port} onChange={(event) => setPort(event.target.value)} className="mt-1 min-h-[44px] w-full rounded border border-hair bg-card px-2 text-body text-primary" /></label><label className="block text-meta text-secondary">页面路径<input data-testid="development-service-manual-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/" className="mt-1 min-h-[44px] w-full rounded border border-hair bg-card px-2 text-body text-primary" /></label><button type="button" data-testid="development-service-manual-open" className="min-h-[44px] text-sub text-link disabled:opacity-50" disabled={!!opening} onClick={() => void openManual()}>确认并打开 ↗</button></div> : null}</> : <p data-testid="development-service-manual-unavailable" className="py-2 text-meta text-tertiary">{!expanded.has(workerId) ? '展开当前机器以确认手动打开是否可用。' : currentDetail?.isPending && currentWorker?.state === 'online' ? '正在确认手动打开是否可用…' : '当前机器暂不支持手动打开，仅可查看服务。'}</p>}</section> : null}
    {notice ? <p role="status" className="mt-3 text-meta text-secondary">{notice}</p> : null}
  </div>;
  if (narrow) return <Sheet title="开发服务" testId="development-services-panel" onClose={onClose}>{content}</Sheet>;
  return <aside aria-label="开发服务" data-testid="development-services-panel" className="flex w-[350px] max-w-[45%] min-w-0 shrink-0 flex-col border-l border-hair bg-panel"><div className="flex min-h-[52px] items-center border-b border-hair px-4"><h2 className="flex-1 text-body font-semibold text-primary">开发服务</h2><button type="button" aria-label="关闭开发服务" className="min-h-[44px] min-w-[44px] text-xl text-secondary" onClick={onClose}>×</button></div>{content}</aside>;
}
