import { localTime } from './local-time.ts';
import { useEffect, useState } from 'react';
import type { AgentDto, ArtifactDto, CanvasDto, JournalEntryDto, SessionActivityDto, SessionDto } from './api.ts';
import { api } from './api.ts';
import { StatusPill } from './status.tsx';
import type { LiveSession } from './live.ts';
import { SessionAssets } from './session-assets.tsx';
import { SessionMessages } from './session-messages.tsx';
import { SessionContext } from './session-context.tsx';
import { FilesBrowser } from './files-browser.tsx';
import { WorkerChip, resolveWorker, useWorkers } from './workers.tsx';

const CAPABILITY_LABEL: Record<string, string> = {
  prompt: '发消息',
  interrupt: '中断',
  fork: '分叉',
  resume: '恢复',
  tool_calls: '工具调用',
  artifacts: '产出物',
  structured_events: '结构化事件',
  attachments: '附件与 @ 引用'
};

type CapabilityName = keyof AgentDto['capabilities'];

function CapabilityRow({ name, capability }: { name: CapabilityName; capability: AgentDto['capabilities'][CapabilityName] }) {
  const mark = capability.state === 'denied' ? '—' : '✓';
  const colour =
    capability.state === 'available' ? 'text-sage' : capability.state === 'limited' ? 'text-accent' : 'text-tertiary';
  return (
    <div className="flex items-start justify-between gap-2 py-0.5">
      <span className="text-meta text-secondary">{CAPABILITY_LABEL[name] ?? name}</span>
      <span className="flex items-baseline gap-1.5 text-right">
        {capability.reason ? (
          <span className="max-w-[150px] truncate text-meta text-tertiary" title={capability.reason}>
            {capability.reason}
          </span>
        ) : null}
        <span className={`font-mono text-meta ${colour}`}>{mark}</span>
      </span>
    </div>
  );
}

interface Props {
  readonly canvas: CanvasDto;
  readonly session: SessionDto;
  readonly artifacts: readonly ArtifactDto[];
  readonly live: LiveSession | null;
  readonly onClose: () => void;
}

/**
 * 会话详情：对话页头上的「详情」打开。桌面是右侧抽屉，手机是底部抽屉。
 *
 * 这里只放「看」的东西——能力、资产、产出物、事件流。动作（分叉、换个地方继续）在对话页的「更多」
 * 和每条消息的操作菜单里；说话在对话里说。点遮罩或按 Esc 关掉。
 */
const ACTION_LABEL: Record<string, string> = {
  'session.start': '开了会话',
  'session.fork': '分叉',
  'session.interrupt': '停下',
  'session.continue': '换机继续'
};

export function SessionDetails({ canvas, session, artifacts, live, onClose }: Props) {
  const [showJournal, setShowJournal] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [journal, setJournal] = useState<readonly JournalEntryDto[]>([]);
  const [activity, setActivity] = useState<readonly SessionActivityDto[]>([]);
  const agent = canvas.agents.find((candidate) => candidate.id === session.agentId);
  const workers = useWorkers();
  const task = canvas.tasks.find((candidate) => candidate.id === session.taskId);

  useEffect(() => {
    void api.activity(session.id).then(setActivity, () => setActivity([]));
  }, [session.id, session.status]);

  useEffect(() => {
    if (!showJournal) return;
    void api.events(session.id).then(setJournal);
  }, [showJournal, session.id, session.lastSeq]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const status = live?.status ?? session.status;
  const capabilityNames = agent ? (Object.keys(agent.capabilities) as CapabilityName[]) : [];
  const limited = capabilityNames.filter((name) => agent!.capabilities[name].state !== 'available');

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/40 md:items-stretch md:justify-end" onClick={onClose}>
      <aside
        aria-label="会话详情"
        className="flex max-h-[85vh] w-full flex-col rounded-t-md border-t border-hair bg-panel pb-[env(safe-area-inset-bottom)] md:h-full md:max-h-none md:w-[360px] md:rounded-none md:border-l md:border-t-0 md:pb-0"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="border-b border-hair px-3 pb-2.5 pt-2">
          <div className="flex items-center gap-2">
            <p className="text-head text-primary">会话详情</p>
            <StatusPill status={status} reason={live?.reason ?? null} lastSeq={live?.lastSeq ?? session.lastSeq} />
            <button className="ml-auto h-9 px-2 text-meta text-tertiary hover:text-primary" onClick={onClose}>
              关闭
            </button>
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-meta text-tertiary">
            <span className="truncate">
              {agent?.label ?? session.agentId} · {session.model === '' ? '默认模型' : session.model}
            </span>
            {workers.multi ? <WorkerChip worker={resolveWorker(workers.list, session.workerId)} /> : null}
            {session.origin.kind === 'fork' ? <span className="shrink-0">· 分叉自 #{session.origin.atSeq}</span> : null}
          </p>
          <p className="mt-1.5 flex min-w-0 items-baseline gap-1.5 text-meta">
            <span className="shrink-0 text-tertiary">任务</span>
            <span className="truncate text-secondary" title={task?.title}>
              {task?.title ?? session.taskId}
            </span>
          </p>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-3 py-2.5">
          {agent !== undefined && limited.length > 0 ? (
            <p className="text-meta text-tertiary">
              <span className="text-accent">●</span> {limited.map((name) => CAPABILITY_LABEL[name] ?? name).join('、')} 受限
            </p>
          ) : null}
          <section>
            <p className="mb-1 text-meta text-tertiary">能力</p>
            {agent ? (
              capabilityNames.map((name) => <CapabilityRow key={name} name={name} capability={agent.capabilities[name]} />)
            ) : (
              <p className="text-meta text-tertiary">该 agent 当前没有在线节点</p>
            )}
          </section>
          <SessionContext sessionId={session.id} lastSeq={live?.lastSeq ?? session.lastSeq} />
          <section data-testid="session-activity">
            <p className="mb-1 text-meta text-tertiary">谁做了什么</p>
            {activity.length === 0 ? (
              <p className="text-meta text-tertiary">没有记录（早于这项功能，或不是登录用户操作的）</p>
            ) : (
              [...activity].reverse().map((item, index) => (
                <p key={index} className="flex min-w-0 items-baseline gap-1.5 text-meta" data-testid="activity-row">
                  <span className="shrink-0 text-secondary">{item.actor.name}</span>
                  <span className="shrink-0 text-primary">{ACTION_LABEL[item.action] ?? item.action}</span>
                  <span className="truncate text-tertiary" title={item.detail}>{item.detail}</span>
                  <span className="ml-auto shrink-0 font-mono text-tertiary">{localTime(item.at)}</span>
                </p>
              ))
            )}
          </section>
          <SessionAssets sessionId={session.id} detailed />
          <SessionMessages sessionId={session.id} />
          <section>
            <button className="text-meta text-accent hover:text-primary" onClick={() => setShowFiles(true)} data-testid="open-files">浏览文件</button>
            {showFiles ? <FilesBrowser sessionId={session.id} status={status} onClose={() => setShowFiles(false)} /> : null}
          </section>
          {artifacts.length > 0 ? (
            <section>
              <p className="mb-1 text-meta text-tertiary">产出物</p>
              {artifacts.map((artifact) => (
                <p key={artifact.id} className="truncate font-mono text-meta text-secondary">
                  ◆ {artifact.path}
                </p>
              ))}
            </section>
          ) : null}
          <section>
            <button className="mb-1 text-meta text-tertiary hover:text-primary" onClick={() => setShowJournal(!showJournal)}>
              {showJournal ? '收起事件流' : '查看事件流'}
            </button>
            {showJournal ? (
              <div className="max-h-[260px] space-y-0.5 overflow-y-auto">
                {journal.map((entry) => (
                  <p key={entry.seq} className="truncate text-meta text-secondary" title={eventLabel(entry.event)}>
                    <span className="text-tertiary/70">#{entry.seq}</span> {eventLabel(entry.event)}
                  </p>
                ))}
                {journal.length === 0 ? <p className="text-meta text-tertiary">没有记录</p> : null}
              </div>
            ) : null}
          </section>
        </div>
      </aside>
    </div>
  );
}

/** 事件流给人看：说「发生了什么」，不念内部类型名。 */
export function eventLabel(event: JournalEntryDto['event']): string {
  switch (event.kind) {
    case 'prompt':
      return `你发送了消息：${event.text.slice(0, 40)}`;
    case 'text':
      return '回复了一段文字';
    case 'thinking':
      return '想了一会儿';
    case 'tool_call':
      return `调用工具 ${event.name}`;
    case 'tool_result':
      return `工具 ${event.name} ${event.ok ? '完成' : '失败'}`;
    case 'artifact':
      return `写了文件 ${event.path}`;
    case 'ended':
      return event.outcome === 'done'
        ? '回复完成'
        : event.outcome === 'stopped'
          ? '已停止'
          : event.outcome === 'interrupted'
            ? '中断了'
            : `出错：${event.reason ?? '没有说原因'}`;
    case 'diagnostic':
      return `${event.level === 'error' ? '出错' : event.level === 'warn' ? '提醒' : '提示'}：${event.text}`;
    case 'context_usage':
      return event.usedTokens === null ? '上下文用量：刚压缩完，等下一轮' : `上下文用量 ${event.usedTokens.toLocaleString()} / ${event.windowTokens.toLocaleString()} token`;
    case 'compaction':
      return event.phase === 'start'
        ? `开始压缩上下文（${event.reason === 'manual' ? '手动' : event.reason === 'overflow' ? '溢出' : '到阈值'}）`
        : event.ok
          ? `压缩完成：${(event.tokensBefore ?? 0).toLocaleString()} → ${(event.tokensAfter ?? 0).toLocaleString()} token`
          : `压缩没成：${event.error ?? '被中止'}`;
    case 'approval':
      return event.phase === 'request'
        ? `请求批准：${event.title ?? event.id}`
        : `批准${event.decision === 'allow' ? '通过' : '被拒'}（${event.by === 'user' ? event.author?.name ?? '用户' : event.by === 'timeout' ? '超时' : '运行时撤回'}）`;
  }
}
