import { modelLabel } from '../../atoms/model-label.ts';
import { localTime } from '../../shell/local-time.ts';
import { useEffect, useState } from 'react';
import type { AgentDto, ArtifactDto, CanvasDto, JournalEntryDto, SessionActivityDto, SessionDto } from '../../shell/api.ts';
import { api } from '../../shell/api.ts';
import { StatusPill } from '../../atoms/status.tsx';
import { Notice } from '../../atoms/notice.tsx';
import type { LiveSession } from '../../atoms/live.ts';
import { SessionAssets } from '../../atoms/session-assets.tsx';
import { SessionPeers } from '../../atoms/session-peers.tsx';
import { SessionMessages } from '../../atoms/session-messages.tsx';
import { SessionContext } from '../../atoms/session-context.tsx';
import { SessionServices } from '../../atoms/services-section.tsx';
import { SessionMcp } from '../../atoms/session-mcp-section.tsx';
import { SessionProjectGrant } from '../../atoms/session-project-grant.tsx';
import { WorkerChip, resolveWorker, useWorkers } from '../../shell/workers.tsx';

const CAPABILITY_LABEL: Record<string, string> = {
  prompt: '发消息',
  interrupt: '中断',
  fork: '分叉',
  resume: '恢复',
  tool_calls: '工具调用',
  artifacts: '产出物',
  structured_events: '细粒度事件',
  attachments: '附件与 @ 引用',
  branch_at_turn: '从中间消息分叉',
  subagent: '子代理'
};

type CapabilityName = keyof AgentDto['capabilities'];

/**
 * 摘要里的模型只留最后一段：`hub-cn-glm-flash/glm-5.3-flash` → `glm-5.3-flash`。
 *
 * 手机上那一行要能一眼看完，provider 前缀通常是发布方的内部叫法；全名在「完整信息」里，
 * 复制、对日志都还在。
 */
function shortModelLabel(model: string): string {
  const full = modelLabel(model);
  const cut = full.lastIndexOf('/');
  return cut >= 0 && cut < full.length - 1 ? full.slice(cut + 1) : full;
}

/**
 * 一行能力。`✓` 完整可用、`≈` 受限、`—` 这个运行时没有。
 *
 * 这里刻意不用警告色：能力矩阵里绝大多数「做不到」是适配层的固有限制，用户点不点都改变不了。
 * 警告色留给「现在就能修」的事（机器离线、改完要重启），否则整屏都是黄的，等于没有警告。
 */
function CapabilityRow({ name, capability }: { name: CapabilityName; capability: NonNullable<AgentDto['capabilities'][CapabilityName]> }) {
  const mark = capability.state === 'available' ? '✓' : capability.state === 'limited' ? '≈' : '—';
  return (
    <div className="flex items-start justify-between gap-2 py-0.5">
      <span className="shrink-0 text-meta text-secondary">{CAPABILITY_LABEL[name] ?? name}</span>
      <span className="flex min-w-0 items-baseline justify-end gap-1.5 text-right">
        {capability.reason ? (
          <span className="min-w-0 truncate text-meta text-tertiary" title={capability.reason}>
            {capability.reason}
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-meta text-tertiary">{mark}</span>
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
  /** 浏览文件：关掉详情，切到会话的「文件」标签页。 */
  readonly onBrowseFiles: () => void;
  /** 宽屏停靠在对话右边（17.5–20rem），不加遮罩、不压住对话；窄屏照旧是底部抽屉。 */
  readonly docked?: boolean;
}

/**
 * 会话详情：对话页头上的「详情」打开。桌面是右侧抽屉，手机是底部抽屉。
 *
 * 手机第一屏只放三件事：这条会话是什么、能改什么、现在为什么不行。
 * - 头部：状态、agent/模型、机器、任务；完整模型和 ID 收在「完整信息」里，摘要里的模型只留最后一段。
 * - 配置（项目能力、MCP）排在前面，因为它们是这一屏唯一能动手的东西。手机上各自收成一行——
 *   标题 + 当前确认的状态（默认全关 / n 项已开 / 读取中 / 读不到），点开才是开关；桌面上默认展开。
 *   摘要报的是服务端已确认的状态，正在写的时候另加「保存中」，不把乐观值说成已生效。
 * - 上下文压成一行估算；能力矩阵、事件流这些排查用的东西收进「诊断」，默认折叠、不用警告色。
 *
 * 动作（分叉、换个地方继续）在对话页的「更多」和每条消息的操作菜单里；说话在对话里说。
 */
const ACTION_LABEL: Record<string, string> = {
  'session.start': '开了会话',
  'session.fork': '分叉',
  'session.interrupt': '停下',
  'session.continue': '换机继续'
};

export function SessionDetails({ canvas, session, artifacts, live, onClose, onBrowseFiles, docked = false }: Props) {
  const [showJournal, setShowJournal] = useState(false);
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
    // 停靠时不抢 Esc：它和对话并排，Esc 留给对话里的菜单和搜索
    if (docked) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, docked]);

  const status = live?.status ?? session.status;
  const capabilityNames = agent ? (Object.keys(agent.capabilities) as CapabilityName[]).filter((name) => agent.capabilities[name]) : [];
  const limited = capabilityNames.filter((name) => agent!.capabilities[name]!.state !== 'available');
  const worker = resolveWorker(workers.list, session.workerId);
  // 只有一台机器且在线时不占一行：那是常态，写在「完整信息」里就够了。
  const showWorker = worker !== undefined && (workers.multi || worker.state !== 'online');
  // 机器不在线是「暂时」的：这类才配警告色，和运行时做不到的能力分开。
  const offline = worker !== undefined && worker.state !== 'online';

  const panel = (
      <aside
        aria-label="会话详情"
        data-docked={docked ? 'true' : undefined}
        className={
          docked
            ? 'flex h-full w-[17.5rem] shrink-0 flex-col border-l border-hair bg-surface-1 xl:w-80'
            : 'flex max-h-[85vh] w-full flex-col rounded-t-[var(--radius-overlay)] border-t border-strong bg-overlay pb-[env(safe-area-inset-bottom)] shadow-overlay md:h-full md:max-h-none md:w-[360px] md:rounded-none md:border-l md:border-t-0 md:pb-0'
        }
        onClick={(event) => event.stopPropagation()}
      >
        <header className="shrink-0 border-b border-hair px-3 pb-2 pt-2">
          <div className="flex min-w-0 items-center gap-2">
            <p className="shrink-0 text-head text-primary">会话详情</p>
            <span className="inline-flex min-w-0 items-center rounded-sm border border-hair px-1.5 py-px">
              <StatusPill status={status} reason={live?.reason ?? null} lastSeq={live?.lastSeq ?? session.lastSeq} />
            </span>
            <button className="ml-auto h-9 shrink-0 px-2 text-meta text-tertiary hover:text-primary" onClick={onClose}>
              关闭
            </button>
          </div>
          <p className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-meta text-tertiary">
            <span className="min-w-0 truncate" title={`${agent?.label ?? session.agentId} · ${modelLabel(session.model)}`}>
              {agent?.label ?? session.agentId} · {shortModelLabel(session.model)}
            </span>
            {showWorker ? <WorkerChip worker={worker} /> : null}
            {session.origin.kind === 'fork' ? <span className="shrink-0">· 分叉自 #{session.origin.atSeq}</span> : null}
          </p>
          <p className="mt-1 flex min-w-0 items-baseline gap-1.5 text-meta">
            <span className="shrink-0 text-tertiary">任务</span>
            <span className="min-w-0 truncate text-secondary" title={task?.title}>
              {task?.title ?? session.taskId}
            </span>
          </p>
          {session.pinned === true ? (
            <p className="mt-1 flex min-w-0 items-baseline gap-1.5 text-meta" data-testid="session-details-pinned">
              <span className="shrink-0 rounded-sm border border-hair px-1 text-secondary" title="不会因空闲被回收">常驻</span>
            </p>
          ) : null}
          {/* 完整模型名、机器、会话 ID：常规情况下上面那行就够看，需要复制 / 报问题时展开。 */}
          <details className="group/more mt-1" data-testid="session-details-more">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-meta text-tertiary hover:text-secondary">
              <span aria-hidden className="inline-block w-2.5 text-center transition-transform group-open/more:rotate-90">
                ›
              </span>
              完整信息
            </summary>
            <dl className="mt-1 space-y-0.5 pl-3.5 font-mono text-[11px] leading-[1.55] text-tertiary" data-testid="session-details-ids">
              <div className="flex min-w-0 gap-1.5">
                <dt className="shrink-0">模型</dt>
                <dd className="min-w-0 break-all text-secondary">{session.model.trim() === '' ? '默认模型' : session.model}</dd>
              </div>
              <div className="flex min-w-0 gap-1.5">
                <dt className="shrink-0">Agent</dt>
                <dd className="min-w-0 break-all">{agent?.label ?? session.agentId} · {session.agentId}</dd>
              </div>
              <div className="flex min-w-0 gap-1.5">
                <dt className="shrink-0">机器</dt>
                <dd className="min-w-0 break-all">
                  {worker ? `${worker.label} · ${worker.state === 'online' ? '在线' : `离线${worker.reason ? `（${worker.reason}）` : ''}`}` : '未知机器'}
                  {session.workerId ? ` · ${session.workerId}` : ''}
                </dd>
              </div>
              <div className="flex min-w-0 gap-1.5">
                <dt className="shrink-0">会话</dt>
                <dd className="min-w-0 break-all">{session.id}</dd>
              </div>
            </dl>
          </details>
        </header>

        <div
          className={
            docked
              ? 'min-h-0 flex-1 space-y-3.5 overflow-y-auto px-3 py-2.5'
              : 'min-h-0 flex-1 space-y-3.5 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] pt-2.5 md:pb-2.5'
          }
        >
          {/* 机器离线只影响「跑」：发消息、看文件这些都要机器在场。项目能力和 MCP 名单是 Hub 上的记录，
              离线照样能改能存——别让这句看起来像连授权都管不了。 */}
          {offline ? (
            <Notice tone="warning" testId="session-worker-offline">
              {worker?.label ?? '这台机器'} 离线：发消息、看文件这些要机器在场的操作现在用不了；项目能力和 MCP
              名单仍然可以改、可以保存，等机器回来重新托管时才生效。
            </Notice>
          ) : null}

          {/* 项目能力：这一屏唯一的写控件，放在前面；默认全关，撤销随时生效。 */}
          <SessionProjectGrant sessionId={session.id} />
          {/* MCP 服务器：启动时下发的清单，这条会话只能做减法，改了等下次重新托管才生效。 */}
          <SessionMcp sessionId={session.id} />
          <SessionContext sessionId={session.id} lastSeq={live?.lastSeq ?? session.lastSeq} />
          {/* 本地服务：容器会话没有工作目录，起不了进程，只保留查看（列表本身就是空的）。 */}
          <SessionServices
            taskId={session.taskId ?? ''}
            scope={{ kind: 'session', sessionId: session.id }}
            choices={[
              {
                id: session.id,
                label: session.agentId,
                root:
                  session.workspaceId === null
                    ? null
                    : (canvas.workspaces.find((workspace) => workspace.id === session.workspaceId)?.path ?? null)
              }
            ]}
            defaultSessionId={session.id}
            canCreate={session.taskId !== null}
          />
          {/* 能力矩阵是排查用的：收进「诊断」，摘要只报数量，不用警告色。 */}
          <details className="group/diag" data-testid="session-diagnostics">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-meta text-secondary hover:text-primary">
              <span aria-hidden className="inline-block w-2.5 text-center transition-transform group-open/diag:rotate-90">›</span>
              诊断
              <span className="min-w-0 truncate text-meta text-tertiary">
                · {agent === undefined ? '未知 agent' : limited.length > 0 ? `${limited.length} 项受限` : '都能用'}
              </span>
            </summary>
            <div className="mt-1.5 space-y-2 pl-4">
              <section>
                <p className="mb-1 text-meta text-tertiary">能力</p>
                {agent ? (
                  capabilityNames.map((name) => <CapabilityRow key={name} name={name} capability={agent.capabilities[name]!} />)
                ) : (
                  <p className="text-meta text-tertiary">该 agent 当前没有在线机器</p>
                )}
                <p className="mt-1 text-meta text-tertiary">✓ 能用 · ≈ 受限 · — 这个运行时没有；原因来自适配层</p>
              </section>
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
          </details>
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
          <SessionPeers sessionId={session.id} />
          <SessionMessages sessionId={session.id} />
          <section>
            <button className="text-meta text-link hover:text-primary" onClick={onBrowseFiles} data-testid="open-files">浏览文件</button>
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
        </div>
      </aside>
  );
  if (docked) return panel;
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/55 md:items-stretch md:justify-end" onClick={onClose}>
      {panel}
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
      if (typeof (event as typeof event & { uncertainDeliveryId?: unknown }).uncertainDeliveryId === 'string') return '暂未确认这一轮的结果';
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
    case 'subagent':
      return event.phase === 'start'
        ? `子代理${event.agent ? ` ${event.agent}` : ''}开始${event.title ? `：${event.title}` : ''}`
        : `子代理${event.agent ? ` ${event.agent}` : ''}${event.status === 'completed' ? '完成' : event.status === 'cancelled' ? '取消' : '失败'}`;
    case 'commands':
      return event.commands.length === 0 ? '运行时没有暴露斜杠命令' : `运行时暴露了 ${event.commands.length} 个斜杠命令`;
  }
}
