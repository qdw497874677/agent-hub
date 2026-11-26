import type { AgentMessagePartDto } from '../shell/api.ts';

export function partLabel(part: AgentMessagePartDto): string {
  if (part.type === 'data') return `数据${part.schema ? ` · ${part.schema}` : ''}`;
  if (part.type === 'ref') return `${part.repo}${part.branch ? `@${part.branch}` : ''}${part.sha ? ` · ${part.sha.slice(0, 7)}` : ''}`;
  if (part.type === 'file') return `文件 · ${part.path}`;
  return part.label ?? part.url;
}

export function Parts({ parts }: { parts: readonly AgentMessagePartDto[] | undefined }) {
  if (!parts?.length) return null;
  return <ul className="my-0.5 flex flex-wrap gap-1" aria-label="附件">{parts.map((part, index) => (
    <li key={index} data-testid="agent-message-part" data-type={part.type} className="max-w-[220px] truncate rounded-sm border border-hair px-1 font-mono text-[10px] text-secondary" title={part.type === 'data' ? JSON.stringify(part.data) : partLabel(part)}>
      {part.type === 'link' ? <a href={part.url} target="_blank" rel="noreferrer" className="text-link">{partLabel(part)}</a> : partLabel(part)}
    </li>
  ))}</ul>;
}
