import { useQuery } from '@tanstack/react-query';
import { api } from '../shell/api.ts';
import { formatRoute, parseRoute } from '../shell/route.ts';
import { projectMessage, type MessageSource, type SourceDetails } from './message-provenance.ts';
import { Parts } from './message-parts.tsx';

export function ProvenanceView({ text, author, messageSource, sessionId, compact = false, details: supplied }: {
  text: string; author?: { via?: string }; messageSource?: MessageSource; sessionId: string; compact?: boolean; details?: SourceDetails;
}) {
  const query = useQuery({
    queryKey: ['message-source', sessionId, messageSource?.messageId],
    queryFn: () => api.messageSource(sessionId, messageSource!.messageId),
    enabled: !!messageSource && !supplied, staleTime: 0, gcTime: 0, retry: false
  });
  const details = supplied ?? (query.isFetching || query.isError ? undefined : query.data);
  const projection = projectMessage({ text, author, messageSource }, details);
  if (projection.kind === 'ordinary') return null;
  const route = parseRoute(window.location.hash);
  const link = details?.sourceSession && route?.page === 'project'
    ? formatRoute({ ...route, view: 'focus', sessionId: details.sourceSession.id }) : null;
  const status = details?.failure ? '失败' : details?.replyStatus === 'failed' ? '失败' : details?.replyStatus === 'refused' ? '拒绝' : details?.replyStatus === 'ok' ? '完成' : null;
  return (
    <div data-testid="agent-message-card" data-provenance={projection.kind} data-kind={projection.messageKind} className={`w-full min-w-0 rounded-md border border-hair bg-card-raised ${compact ? 'max-w-[95%] px-2 py-1' : 'max-w-[85%] px-3 py-2'}`}>
      <p className="flex flex-wrap items-baseline gap-x-2 text-meta">
        <span className="font-medium text-primary">{projection.heading}</span>
        {status ? <span className={status === '完成' ? 'text-sage' : 'text-rust'}>{status}</span> : null}
      </p>
      <p className="mt-0.5 break-words text-meta text-tertiary">
        {projection.origin}{link ? <> · <a className="text-link underline" href={link}>查看来源会话</a></> : null}
      </p>
      {projection.body ? <p className={`mt-1 whitespace-pre-wrap break-words text-primary ${compact ? 'line-clamp-4 text-meta' : 'max-h-60 overflow-auto text-chat'}`}>{projection.body}</p> : null}
      <Parts parts={details?.parts} />
    </div>
  );
}
