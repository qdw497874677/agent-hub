import { useEffect, useState } from 'react';
import { Notice } from './notice.tsx';
import { contextApi, type SessionContextDto } from '../shell/api.ts';

const SOURCE: Record<SessionContextDto['source'], string> = { session: '会话设置', role: '角色设置', project: '项目设置', hub: 'hub 默认', default: '默认' };
const MODE: Record<SessionContextDto['mode'], string> = { native: '运行时原生', 'hub-managed': 'hub 管理', 'runtime-plugin': '运行时插件' };
const L1: Record<string, string> = { usage: '用量', compactionEvents: '压缩事件', transcript: '记录导出', compact: '触发压缩', restart: '重启会话', memoryTools: '记忆工具' };

/**
 * 会话详情里的「上下文」一节：生效策略、来源、退回原因、估算用量、L1 缺口。
 *
 * 首屏只留两行——策略 + 一条估算用量。`✓/≈/—` 那串能力明细和缺口说明是排查用的，
 * 收进「细节」和「n 项说明」，默认折叠；「立即压缩」是唯一要动手的东西，排在同一行右侧。
 */
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
  const { usage, capability } = view;
  const pct = Math.min(100, Math.round(usage.usedRatio * 100));
  const missing = Object.values(capability.l1).filter((level) => level === 'missing').length;
  const estimated = Object.values(capability.l1).filter((level) => level === 'estimated').length;
  const lastCompaction = usage.lastCompaction;
  return (
    <section data-testid="session-context" className="min-w-0">
      <div className="flex min-w-0 items-baseline gap-2">
        <p className="shrink-0 text-meta text-secondary">上下文</p>
        <p
          data-testid="context-strategy"
          className="min-w-0 flex-1 truncate text-meta text-tertiary"
          title={`${MODE[view.mode]} · 来自${SOURCE[view.source]}`}
        >
          {view.strategy.title}
        </p>
        {capability.l1.compact === 'runtime' ? (
          <button
            type="button"
            data-testid="context-compact"
            className="shrink-0 rounded-sm border border-hair px-1.5 py-0.5 text-meta text-secondary hover:text-primary"
            onClick={compact}
          >
            立即压缩
          </button>
        ) : null}
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2">
        <div
          className={`h-1 min-w-8 flex-1 rounded-full ${usage.level === 'ok' ? 'bg-hair' : 'bg-warning/25'}`}
          title={`${usage.usedTokens} / ${usage.windowTokens}`}
        >
          <div className={`h-1 rounded-full ${usage.level === 'ok' ? 'bg-tertiary' : 'bg-warning'}`} style={{ width: `${pct}%` }} />
        </div>
        <p
          data-testid="context-usage"
          className="shrink-0 font-mono text-meta text-tertiary"
          title={usage.estimated ? '平台估算' : '运行时报告'}
        >
          {usage.estimated ? '约 ' : ''}
          {usage.usedTokens.toLocaleString()} / {usage.windowTokens.toLocaleString()}（{pct}%）
        </p>
      </div>
      {view.fallback ? (
        <Notice tone="warning" testId="context-fallback" className="mt-1">
          选的「{view.fallback.wanted}」{view.fallback.reason}，已退回默认
        </Notice>
      ) : null}
      {note ? <p className="mt-1 text-meta text-tertiary" data-testid="context-compact-note">{note}</p> : null}
      <details className="group/detail mt-1" data-testid="context-details">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-meta text-tertiary hover:text-secondary">
          <span aria-hidden className="inline-block w-2.5 text-center transition-transform group-open/detail:rotate-90">›</span>
          细节
          <span className="min-w-0 truncate">
            ·{' '}
            {missing === 0
              ? '这个运行时都能给'
              : `${missing} 项这个运行时给不了${estimated > 0 ? `，${estimated} 项是估算` : ''}`}
          </span>
        </summary>
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 pl-3.5 text-meta text-tertiary" data-testid="context-capabilities">
          {Object.entries(capability.l1).map(([key, level]) => (
            <div key={key} className="flex min-w-0 items-baseline justify-between gap-1">
              <dt className="min-w-0 truncate">{L1[key] ?? key}</dt>
              <dd className={`shrink-0 font-mono ${level === 'runtime' ? 'text-secondary' : 'text-tertiary'}`}>
                {level === 'runtime' ? '✓' : level === 'estimated' ? '≈' : '—'}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-0.5 pl-3.5 text-meta text-tertiary">策略来自{SOURCE[view.source]} · {MODE[view.mode]}</p>
        <p className="mt-0.5 pl-3.5 text-meta text-tertiary">✓ 运行时直接给 · ≈ 平台估算 · — 这个运行时没有</p>
        {lastCompaction ? (
          <p className="mt-0.5 pl-3.5 text-meta text-tertiary" data-testid="context-last-compaction">
            上次压缩：
            {lastCompaction.ok
              ? `${(lastCompaction.tokensBefore ?? 0).toLocaleString()} → ${(lastCompaction.tokensAfter ?? 0).toLocaleString()} token`
              : '没成功'}
          </p>
        ) : null}
      </details>
      {/* 说明默认折起来：它们是「为什么这个运行时是这样」，不是待办。 */}
      <details className="group/gap mt-1" data-testid="context-gaps">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-meta text-tertiary hover:text-secondary">
          <span aria-hidden className="inline-block w-2.5 text-center transition-transform group-open/gap:rotate-90">›</span>
          {capability.gaps.length === 0 ? '没有额外说明' : `${capability.gaps.length} 项说明`}
        </summary>
        {capability.gaps.length > 0 ? (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-meta leading-[1.55] text-tertiary">
            {capability.gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        ) : null}
      </details>
    </section>
  );
}
