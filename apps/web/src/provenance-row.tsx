import { useEffect, useState } from 'react';
import { api, type ProvenanceDto } from './api.ts';
import { localTime } from './local-time.ts';

const VIA: Record<string, string> = {
  web: '网页', mobile: '手机', api: '开放 API', fork: '分叉', rewind: '回退', handoff: '交接',
  continue_elsewhere: '换机继续', bot: 'bot', group: '群聊'
};
const ROLE: Record<string, string> = { owner: '完整（所有者）', admin: '完整（管理员）', member: '成员', viewer: '只读', system: '系统', unknown: '未记录' };

function fullTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromText(p: ProvenanceDto): string {
  if (!p.parent) return '';
  const name = p.parentTitle || p.parent.sessionId.slice(0, 8);
  const verb = p.via === 'rewind' ? '回退' : p.via === 'continue_elsewhere' ? '接着' : p.via === 'handoff' ? '交接' : '分叉';
  return verb === '接着' ? `接着「${name}」` : `从「${name}」${verb}`;
}

function actorText(p: ProvenanceDto): string {
  if (p.backfilled) return '未记录';
  if (p.actor.kind === 'api_token') return `令牌「${p.actor.name || p.actor.id}」`;
  if (p.actor.kind === 'agent') return `agent「${p.actor.name || p.actor.id}」`;
  if (p.actor.kind === 'system') return '系统';
  return p.actor.name || p.actor.id;
}

function originText(p: ProvenanceDto): string {
  if (!p.parent) {
    if (p.backfilled) return '未记录（原会话没有来源信息）';
    return `${VIA[p.via] ?? p.via}创建`;
  }
  const base = fromText(p);
  const step = p.parent.atSeq !== undefined ? `（第 ${p.parent.atSeq} 步）` : '';
  return p.backfilled ? `${base}${step}（按分叉关系补录）` : `${base}${step}`;
}

function permissionText(p: ProvenanceDto): string {
  if (p.backfilled) return '未记录';
  const role = ROLE[p.authority.role] ?? p.authority.role;
  return p.authority.scope?.length ? `${role} · 收窄到：${p.authority.scope.join(', ')}` : role;
}

/** 一行文字版来历，收件箱悬停也用它。 */
export function provenanceSummary(p: ProvenanceDto): string {
  const actor = p.backfilled ? '原发起人未记录' : actorText(p);
  const origin = p.parent ? fromText(p) : p.backfilled ? '来源未记录' : `${VIA[p.via] ?? p.via}创建`;
  return [actor, origin, localTime(p.createdAt)].filter(Boolean).join(' · ');
}

/** 会话页顶部可折叠的「来历」一行（ADR 0031 D3）。默认收起，只读。 */
export function ProvenanceRow({ sessionId }: { sessionId: string }) {
  const [p, setP] = useState<ProvenanceDto | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    setP(null);
    setOpen(false);
    setCopied(false);
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
          <dt>发起人</dt><dd className="break-all">{actorText(p)}</dd>
          <dt>来源</dt><dd className="break-all">{originText(p)}</dd>
          <dt>权限</dt><dd className="break-all">{permissionText(p)}</dd>
          <dt>时间</dt><dd>{fullTime(p.createdAt)}</dd>
          {p.backfilled ? (<><dt>备注</dt><dd>老会话补录：原发起人和权限当时未记录{p.parent ? '，来源按分叉关系推断' : ''}。</dd></>) : null}
          <dt>编号</dt><dd className="flex min-w-0 items-center gap-2"><span className="truncate font-mono" title={p.id}>{p.id.slice(0, 8)}…</span>
            <button type="button" className="shrink-0 rounded-sm border border-hair px-1 hover:text-primary" aria-label="复制来历编号"
              onClick={() => { void navigator.clipboard?.writeText(p.id).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1_500); }, () => undefined); }}>
              {copied ? '已复制' : '复制'}
            </button></dd>
        </dl>
      ) : null}
    </div>
  );
}
