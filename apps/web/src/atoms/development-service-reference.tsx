import { useContext, useLayoutEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { developmentServicesApi } from '../shell/api/development-services.ts';
import { useAccount } from '../shell/auth.tsx';
import { safePreviewUrl } from './preview-workflow-model.ts';
import { DevelopmentLaunchScope, useDevelopmentLaunch } from './development-service-launch.ts';
import { developmentServiceLabels } from './development-service-model.ts';

/** Only ordinary user prompt lines are parsed by the caller, not assistant/tool/provenance text. */
export function UserPromptWithServices({ text, sessionId }: { text: string; sessionId: string }) {
  const lines = text.split('\n');
  return <>{lines.map((line, index) => {
    const match = /^\[\[dev-service:(ds_[0-9a-f]{64}\.[A-Za-z0-9_-]{8,512})\]\]$/.exec(line);
    return match ? <DevelopmentServiceReference key={index} id={match[1]!} sessionId={sessionId} /> : <span key={index}>{line}{index < lines.length - 1 ? '\n' : ''}</span>;
  })}</>;
}
function DevelopmentServiceReference({ id, sessionId }: { id: string; sessionId: string }) {
  const account = useAccount();
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState('');
  const scope = useContext(DevelopmentLaunchScope);
  const launch = useDevelopmentLaunch(JSON.stringify([account?.id, sessionId, id]));
  useLayoutEffect(() => { setOpening(false); setNotice(''); }, [scope, account?.id, sessionId, id]);
  const service = useQuery({ queryKey: ['development-services', account?.id ?? 'anon', 'service', id], queryFn: () => developmentServicesApi.service(id), retry: false, staleTime: 0, refetchInterval: 15000 });
  async function open() {
    if (opening || service.data?.service.id !== id || !service.data.service.openable || service.isError || service.isFetching) return;
    setOpening(true); setNotice('');
    const request = launch();
    const popup = request.popup;
    try {
      const result = await developmentServicesApi.open(id);
      if (!request.active()) return;
      const url = result.state === 'ready' ? safePreviewUrl(result.url) : null;
      if (url && popup) popup.location.replace(url);
      else { popup?.close(); setNotice(result.state === 'pending' ? '服务正在准备，请稍后重新确认。' : url ? '浏览器阻止了打开新窗口。' : '服务地址暂不可用。'); }
    } catch { if (request.active()) { popup?.close(); setNotice('打开结果未确认，请重新查看服务状态。'); void service.refetch(); } }
    finally { if (request.active()) setOpening(false); request.finish(); }
  }
  const item = service.isError || service.data?.service.id !== id ? null : service.data.service;
  const labels = item ? developmentServiceLabels(item) : null;
  return <span data-testid="development-service-reference-card" className="my-1 flex min-w-0 items-center gap-3 rounded border border-hair bg-card px-3 py-1 text-left"><span className="min-w-0 flex-1"><span className="block truncate text-sub text-primary">{labels?.title ?? '开发服务'}</span><span className="block text-meta text-tertiary">{service.isPending ? '正在确认…' : !item ? '已停止或不可用' : labels?.subtitle}</span>{notice ? <span role="status" className="block text-meta text-secondary">{notice}</span> : null}</span>{item?.openable && !service.isFetching ? <button type="button" data-testid="development-service-reference-open" className="min-h-[44px] min-w-[44px] shrink-0 text-meta text-link disabled:opacity-50" disabled={opening} onClick={() => void open()}>打开 ↗</button> : null}</span>;
}
