import { useEffect, useState } from 'react';
import { api, type ProvenanceDto } from './api.ts';
import { localTime } from './local-time.ts';

const VIA: Record<string, string> = {
  web: '网页', mobile: '手机', api: '开放 API', fork: '分叉', rewind: '回退', handoff: '交接',
  continue_elsewhere: '换机继续', bot: 'bot', group: '群聊'
};
const ROLE: Record<string, string> = { owner: '完整（所有者）', admin: '完整（管理员）', member: '成员', viewer: '只读', system: '系统', unknown: '未知' };

function fromText(p: ProvenanceDto): string {
  if (!p.parent) return '';
  const name = p.parentTitle || p.parent.sessionId.slice(0, 8);
  const verb = p.via === 'rewind' ? '回退' : p.via === 'continue_elsewhere' ? '接着' : p.via === 'handoff' ? '交接' : '分叉';
  return verb === '接着' ? `接着「${name}」` : `从「${name}」${verb}`;
}

/** 一行文字版来历，收件箱悬停也用它。 */
export function provenanceSummary(p: ProvenanceDto): string {
  const authority = p.authority.scope?.length ? `收窄到 ${p.authority.scope.length} 项权限` : (ROLE[p.authority.role] ?? p.authority.role);
  return [p.actor.name, p.parent ? fromText(p) : (VIA[p.via] ?? p.via), `权限：${authority}`, localTime(p.createdAt)].filter(Boolean).join(' · ');
}

/** 会话页顶部可折叠的「来历」一行（ADR 0031 D3）。默认收起，只读。 */
export function ProvenanceRow({ sessionId }: { sessionId: string }) {
  const [p, setP] = useState<ProvenanceDto | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    setP(null);
    api.provenance(sessionId).then((r) => { if (alive) setP(r); }, () => undefined);
    return () => { alive = false; };
  }, [sessionId]);
  if (!p) return null;
  return (
    <div className="shrink-0 border-b border-hair px-2 py-1 text-meta text-tertiary md:px-3" data-testid="provenance-row">
      <button type="button" className="flex w-full min-w-0 items-center gap-1 text-left hover:text-primary" aria-expanded={open}
        onClick={() => setOpen((v) => !v)} data-testid="provenance-toggle">
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        <span className="shrink-0">来历</span>
        {p.backfilled ? <span className="shrink-0 rounded-sm border border-hair px-1" data-testid="provenance-backfilled">补录</span> : null}
        <span className="truncate">：{provenanceSummary(p)}</span>
      </button>
      {open ? (
        <dl className="mt-1 grid grid-cols-[4.5em_1fr] gap-x-2 gap-y-0.5 pl-4" data-testid="provenance-details">
          <dt>发起</dt><dd className="break-all">{p.actor.name}{p.actor.kind === 'api_token' ? '（开放 API 令牌）' : p.actor.kind === 'system' ? '（系统）' : ''}</dd>
          <dt>途径</dt><dd>{VIA[p.via] ?? p.via}</dd>
          {p.parent ? (<><dt>来源</dt><dd className="break-all">{fromText(p)}{p.parent.atSeq !== undefined ? ` · 第 ${p.parent.atSeq} 步` : ''}</dd></>) : null}
          <dt>权限</dt><dd className="break-all">{ROLE[p.authority.role] ?? p.authority.role}{p.authority.scope?.length ? ` · 收窄到：${p.authority.scope.join(', ')}` : ''}</dd>
          <dt>时间</dt><dd>{localTime(p.createdAt)}</dd>
          {p.backfilled ? (<><dt>说明</dt><dd>老会话，按当时的分叉关系补录；不知道是谁发起的，所以不写人名</dd></>) : null}
          <dt>编号</dt><dd className="break-all font-mono">{p.id}</dd>
        </dl>
      ) : null}
    </div>
  );
}
