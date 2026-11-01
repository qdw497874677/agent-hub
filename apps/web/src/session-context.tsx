import { useEffect, useState } from 'react';
import { contextApi, type SessionContextDto } from './api.ts';

const SOURCE: Record<SessionContextDto['source'], string> = { session: '会话设置', role: '角色设置', project: '项目设置', hub: 'hub 默认', default: '默认' };
const MODE: Record<SessionContextDto['mode'], string> = { native: '运行时原生', 'hub-managed': 'hub 管理', 'runtime-plugin': '运行时插件' };
const L1: Record<string, string> = { usage: '用量', compactionEvents: '压缩事件', transcript: '记录导出', compact: '触发压缩', restart: '重启会话', memoryTools: '记忆工具' };

/** 会话详情里的「上下文」一节：生效策略、来源、退回原因、估算用量、L1 缺口。 */
export function SessionContext({ sessionId, lastSeq }: { sessionId: string; lastSeq: number }) {
  const [view, setView] = useState<SessionContextDto | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void contextApi.session(sessionId).then(setView, () => setView(null));
  }, [sessionId, lastSeq]);
  const compact = () => {
    setNote('已请求压缩…');
    contextApi.compact(sessionId).then(
      () => setNote('已请求压缩，结果会出现在事件流里'),
      (e: Error) => setNote(e.message)
    );
  };
  if (!view) return null;
  const pct = Math.min(100, Math.round(view.usage.usedRatio * 100));
  return (
    <section data-testid="session-context">
      <p className="mb-1 text-meta text-tertiary">上下文</p>
      <p className="text-meta text-secondary" data-testid="context-strategy">
        {view.strategy.title} · {MODE[view.mode]} · 来自{SOURCE[view.source]}
      </p>
      {view.fallback ? (
        <p className="text-meta text-accent" data-testid="context-fallback">
          选的「{view.fallback.wanted}」{view.fallback.reason}，已退回默认
        </p>
      ) : null}
      <div className="mt-1 h-1.5 w-full rounded bg-hair" title={`${view.usage.usedTokens} / ${view.usage.windowTokens}`}>
        <div className={`h-1.5 rounded ${view.usage.level === 'ok' ? 'bg-tertiary' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-0.5 font-mono text-meta text-tertiary" data-testid="context-usage">
        {view.usage.estimated ? '约 ' : ''}
        {view.usage.usedTokens.toLocaleString()} / {view.usage.windowTokens.toLocaleString()} token（{pct}%）{view.usage.estimated ? ' · hub 估算' : ' · 运行时报告'}
      </p>
      {view.usage.lastCompaction ? (
        <p className="text-meta text-tertiary" data-testid="context-last-compaction">
          上次压缩：
          {view.usage.lastCompaction.ok
            ? `${(view.usage.lastCompaction.tokensBefore ?? 0).toLocaleString()} → ${(view.usage.lastCompaction.tokensAfter ?? 0).toLocaleString()} token`
            : '没成功'}
        </p>
      ) : null}
      {view.capability.l1.compact === 'runtime' ? (
        <button type="button" data-testid="context-compact" className="mt-1 rounded border border-hair px-1.5 py-0.5 text-meta text-secondary hover:text-primary" onClick={compact}>
          立即压缩
        </button>
      ) : null}
      {note ? <p className="text-meta text-tertiary" data-testid="context-compact-note">{note}</p> : null}
      <p className="mt-1 text-meta text-tertiary">
        {Object.entries(view.capability.l1).map(([key, level]) => (
          <span key={key} className="mr-2 inline-block">
            {L1[key] ?? key}
            {level === 'runtime' ? '✓' : level === 'estimated' ? '≈' : '✗'}
          </span>
        ))}
      </p>
      {view.capability.gaps.length > 0 ? (
        <ul className="mt-0.5 list-disc pl-4 text-meta text-tertiary" data-testid="context-gaps">
          {view.capability.gaps.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
