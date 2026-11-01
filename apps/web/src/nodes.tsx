import { AuthorTag } from './author.tsx';
import { Handle, NodeResizeControl, Position, type NodeProps, type Node } from '@xyflow/react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionDto, TaskDto, WorkerInfoDto } from './api.ts';
import { WorkerChip } from './workers.tsx';
import { ResourceBadge, SessionUsage } from './resources.tsx';
import { CardComposer } from './card-composer.tsx';
import { StatusPill } from './status.tsx';
import { OptionControls } from './options.tsx';
import { cardBlocks, multipleAuthors, waitingForReply, type LiveSession } from './live.ts';
import { NEXT_STATUS } from './task-status.ts';
import { TaskBadge } from './task-detail.tsx';
import { useStickToBottom } from './use-stick-to-bottom.ts';
import { CARD_LIMITS, type CardKind, type Size } from './card-size.ts';

/** 两种卡片共有：拖过的尺寸（没有 = 宽度默认、高度随内容），以及拖完后的回调。 */
type Resizable = {
  size: Size | undefined;
  onResized: (box: Size & { x: number; y: number }) => void;
};

export type TaskNode = Node<
  {
    task: TaskDto;
    sessionCount: number;
    onStatus: (status: TaskDto['status']) => void;
    /** 打开任务详情（状态、当前进展、工作日志）。 */
    onDetail: () => void;
    /** 开一条新会话（领域里叫派生：会话是从任务派生出来的）。 */
    onDerive: () => void;
  } & Resizable,
  'task'
>;
export type SessionNode = Node<
  {
    session: SessionDto;
    live: LiveSession | undefined;
    agentLabel: string;
    /** 多台 Worker 时才有：会话跑在哪台。 */
    worker?: WorkerInfoDto | undefined;
    /** 会话所在机器的资源（单机也有），用来显示这条会话的用量。 */
    resources?: WorkerInfoDto['resources'];
    /** 「机器 · 工作空间 · 分支」（§4，卡片上）；老会话没有工作空间时不显示。 */
    place?: { readonly machine: string; readonly workspace: string; readonly path: string; readonly branch: string | null; readonly kept: string | null } | undefined;
    onOpen: () => void;
    /** 在画布里展开成窗口（双击卡片、⤢、右键）。 */
    onExpand: () => void;
    /** 已经展开成窗口了：卡上标一下。 */
    expanded: boolean;
    /** 卡片上就地说话：不必先打开专注对话。 */
    draft: string;
    onDraftChange: (text: string) => void;
    onSend: (text: string) => Promise<void>;
    onInterrupt: () => Promise<void>;
    onChangeOption: (optionId: string, value: string | boolean) => Promise<void>;
  } & Resizable,
  'session'
>;


/**
 * React Flow 自带的缩放把手，只在选中时出现，免得平时挡住卡片上的按钮。
 * 触屏上把手放大到手指点得中（styles.css 的 pointer: coarse 规则）。
 */
function CardResizer({ kind, selected, onResized }: { kind: CardKind; selected: boolean; onResized: Resizable['onResized'] }) {
  const limits = CARD_LIMITS[kind];
  return (
    // 只留右下角一个缩放把手：四边/四角的把手（尤其触屏放大后）会盖住顶栏的拖动区，选中后一拖就变成了缩放。
    selected ? (
      <NodeResizeControl
        position="bottom-right"
        minWidth={limits.minWidth}
        minHeight={limits.minHeight}
        maxWidth={limits.maxWidth}
        maxHeight={limits.maxHeight}
        color="var(--color-accent)"
        className="card-resize-handle"
        onResizeEnd={(_, box) => onResized(box)}
      />
    ) : null
  );
}

function BlockView({ block, showAuthor }: { block: LiveSession['blocks'][number]; showAuthor: boolean }) {
  if (block.kind === 'thinking') return null;
  if (block.kind === 'prompt') {
    // 和对话页一样：用户的话靠右的气泡，卡片上收紧一点。附件只列名字。
    const names = block.attachments.map((item) => (item.kind === 'mention' ? `@${item.path}` : item.name));
    return (
      <div className="flex flex-col items-end gap-0.5" data-testid="card-msg-user">
        {showAuthor ? <AuthorTag author={block.author} size="sm" /> : null}
        {block.text !== '' ? (
          <p className="max-w-[85%] whitespace-pre-wrap rounded-md rounded-br-sm bg-card-raised px-2 py-1 text-meta text-primary">{block.text}</p>
        ) : null}
        {names.length > 0 ? <p className="max-w-[85%] truncate font-mono text-meta text-tertiary">{names.join(' · ')}</p> : null}
      </div>
    );
  }
  if (block.kind === 'unknown') {
    return (
      <p role="status" className="whitespace-pre-wrap border-l-2 border-ochre bg-ochre/10 px-2 py-1 text-meta text-ochre">
        这一轮结果不确定，打开对话决定是否重发
      </p>
    );
  }
  if (block.kind === 'error') {
    return (
      <p role="alert" className="whitespace-pre-wrap border-l-2 border-rust bg-rust/10 px-2 py-1 text-meta text-rust">
        {block.text}
      </p>
    );
  }
  if (block.kind === 'stall') {
    return (
      <p role="status" className="border-l border-rust pl-2 text-meta text-rust">
        {block.text}
      </p>
    );
  }
  if (block.kind === 'text') {
    return <p className="whitespace-pre-wrap text-body text-primary/90">{block.text}</p>;
  }
  if (block.kind === 'tool') {
    const mark = block.result === null ? '⋯' : block.result.ok ? '✓' : '✗';
    const spent = block.result === null ? '' : ` · ${block.result.durationMs}ms`;
    return (
      <div className="flex items-baseline gap-2 border-l border-hair pl-2 text-meta text-secondary">
        <span className="text-tertiary">{mark}</span>
        <span className="font-mono text-sage">{block.name}</span>
        <span className="truncate opacity-60">{block.input.slice(0, 80)}</span>
        <span className="text-tertiary">{spent}</span>
      </div>
    );
  }
  if (block.kind === 'approval') {
    // 卡片上只提醒；允许 / 拒绝在打开的对话里点（按钮够大，手机也点得准）
    return (
      <p role="status" className="truncate border-l border-ochre pl-2 text-meta text-ochre" data-testid="card-approval">
        {block.resolved ? (block.resolved.decision === 'allow' ? '已允许：' : '已拒绝：') : '等你批准：'}
        <span className="font-mono">{block.title.slice(0, 80)}</span>
      </p>
    );
  }
  return (
    <div className="flex items-baseline gap-2 text-meta">
      <span className="text-accent-dim">◆</span>
      <span className="truncate font-mono text-secondary">{block.path.split('/').pop()}</span>
      <span className="text-tertiary">{block.bytes > 0 ? `${Math.round(block.bytes / 1024)}K` : ''}</span>
    </div>
  );
}

export function SessionCard({ data, selected }: NodeProps<SessionNode>) {
  const { session, live, agentLabel, worker, resources, place, onOpen, onExpand, expanded, draft, onDraftChange, onSend, onInterrupt, onChangeOption, size, onResized } =
    data;
  // 每张卡自己的发送状态：一张卡在等响应，不该让整块画布跟着变灰。
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const status = live?.status ?? session.status;
  const failed = status === 'failed' || status === 'interrupted';
  const failureReason = failed ? (live?.reason ?? null) : null;
  const blocks = live?.blocks ?? [];
  const showAuthor = multipleAuthors(blocks);
  const dimmed = status === 'stopped';
  const scroller = useStickToBottom<HTMLDivElement>(session.id);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <div
      // 双击整张卡在画布里展开成窗口（进会话页用「打开」）。不能只靠 React Flow 的 onNodeDoubleClick：
      // 卡片中段被输入框盖住了，而它会把表单控件上的双击事件当成「用户在编辑」而忽略。
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest('input, textarea, button, select, a')) return;
        onExpand();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        // 菜单挂到 body 上、用屏幕坐标：不受画布缩放影响，也不会被画布上的会话窗口挡住
        //（键盘菜单键 / 合成事件可能没有坐标：退回卡片左上角）
        const box = event.currentTarget.getBoundingClientRect();
        const x = Number.isFinite(event.clientX) && event.clientX > 0 ? event.clientX : box.left + 12;
        const y = Number.isFinite(event.clientY) && event.clientY > 0 ? event.clientY : box.top + 12;
        setMenu({ x: Math.max(4, Math.min(x, window.innerWidth - 176)), y: Math.max(4, Math.min(y, window.innerHeight - 96)) });
      }}
      // 宽高由 React Flow 节点本身决定（node.width/height），卡片只铺满；输出区吃掉剩余高度。
      className={`group flex h-full w-full flex-col rounded-md border bg-card px-3 py-3 transition-colors ${
        selected ? 'border-accent' : 'border-hair'
      } ${dimmed ? 'opacity-70' : ''}`}
    >
      <CardResizer kind="session" selected={selected} onResized={onResized} />
      {menu ? createPortal(
        <>
          <div className="nodrag fixed inset-0 z-[60]" onPointerDown={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null); }} />
          <div role="menu" className="nodrag fixed z-[61] flex min-w-40 flex-col rounded-sm border border-hair bg-card py-1 shadow-md" style={{ left: menu.x, top: menu.y }}>
            <button role="menuitem" className="px-3 py-1.5 text-left text-meta text-primary hover:bg-hair/40" onClick={(event) => { event.stopPropagation(); setMenu(null); onExpand(); }}>
              在画布中展开
            </button>
            <button role="menuitem" className="px-3 py-1.5 text-left text-meta text-primary hover:bg-hair/40" onClick={(event) => { event.stopPropagation(); setMenu(null); onOpen(); }}>
              打开会话页
            </button>
          </div>
        </>,
        document.body,
      ) : null}
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-strong" />
      <header className="card-drag-zone mb-2 flex cursor-grab touch-none select-none items-center justify-between gap-2">
        <div className="flex items-baseline gap-2 overflow-hidden">
          {/* 拖动把手：卡片里的对话区只管滚动，移动卡片按住顶栏（或这个把手）拖 */}
          <span aria-hidden title="按住顶栏拖动卡片" data-testid="card-drag-handle" className="shrink-0 cursor-grab select-none text-meta text-tertiary">
            ⠿
          </span>
          <span className="shrink-0 text-head text-primary">{agentLabel}</span>
          {/* 没有可调项清单（老会话还没人报过）时退回显示模型名 */}
          {session.optionSpec.length === 0 ? (
            <span className="truncate font-mono text-meta text-tertiary">
              {session.model === '' ? '默认模型' : session.model}
            </span>
          ) : null}
          {worker ? <WorkerChip worker={worker} /> : null}
          <SessionUsage resources={resources} sessionId={session.id} />
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          {expanded ? <span className="text-meta text-accent" title="已在画布中展开" data-testid="card-expanded">◫</span> : null}
          <button
            className={`nodrag rounded-sm border px-1.5 py-0.5 text-meta transition-opacity hover:border-accent hover:text-accent focus:opacity-100 ${
              selected ? 'border-accent text-accent' : 'border-hair text-tertiary pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100'
            }`}
            title="在画布中展开（也可以双击卡片）"
            aria-label="在画布中展开"
            onClick={(event) => {
              event.stopPropagation();
              onExpand();
            }}
          >
            ⤢
          </button>
          <button
            className={`nodrag rounded-sm border px-1.5 py-0.5 text-meta transition-opacity hover:border-accent hover:text-accent focus:opacity-100 ${
              selected ? 'border-accent text-accent' : 'border-hair text-tertiary pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100'
            }`}
            title="打开会话页"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            打开
          </button>
          <StatusPill status={status} reason={failureReason} lastSeq={live?.lastSeq ?? session.lastSeq} />
        </span>
      </header>

      {place ? (
        <p className="mb-2 flex flex-wrap gap-x-1 text-meta text-tertiary" title={place.path}>
          <span>{place.machine}</span>
          <span>·</span>
          <span className="max-w-[12rem] truncate">{place.workspace}</span>
          {place.branch ? (
            <>
              <span>·</span>
              <span className="max-w-[14rem] truncate font-mono" title="这个任务的改动都在这个分支上，不会碰到主分支。">
                {place.branch}
              </span>
            </>
          ) : null}
          {place.kept ? (
            <span className="text-rust" title={`还有没保存的改动（${place.kept}），所以没有清理。点开处理。`}>
              · 已保留
            </span>
          ) : null}
        </p>
      ) : null}

      {/* 可调项自己占一行：卡片只有 320px，和 agent 名、状态位挤在一行会把模型名截成三个字 */}
      {session.optionSpec.length === 0 ? null : (
        <div className="nodrag mb-2">
          <OptionControls
            options={session.optionSpec}
            values={session.options}
            onChange={(optionId, value) => void run(() => onChangeOption(optionId, value))}
            compact
          />
        </div>
      )}

      <div
        ref={scroller}
        // nowheel/nopan/nodrag：滚轮、触摸滑动滚的是这段对话，不是拖动或缩放画布。
        data-testid="session-card-log"
        className={`nowheel nopan nodrag min-h-0 flex-1 cursor-auto select-text touch-pan-y space-y-1.5 overflow-y-auto overscroll-contain pr-1 ${size ? '' : 'max-h-[320px]'}`}>
        {failureReason ? (
          <p className="border-l border-rust pl-2 text-meta text-rust">{failureReason}</p>
        ) : null}
        {blocks.length === 0 ? (
          <p className="text-meta text-tertiary">
            {status === 'running' && (live?.lastSeq ?? session.lastSeq) === 0
              ? session.origin.kind === 'fork'
                ? '已从来源的最新处分叉，带着之前的上下文，发一句话接着聊'
                : '就绪，发一句话开始'
              : '尚无输出'}
          </p>
        ) : (
          cardBlocks(blocks).map((block, index) => <BlockView key={index} block={block} showAuthor={showAuthor} />)
        )}
      </div>

      <CardComposer
        session={{ ...session, status }}
        awaiting={waitingForReply(live, status)}
        draft={draft}
        onDraftChange={onDraftChange}
        onSend={(text) => void run(() => onSend(text))}
        onInterrupt={() => void run(onInterrupt)}
        busy={busy}
        error={error}
      />

      <footer className="mt-2 flex items-center justify-between border-t border-hair pt-1.5 text-meta text-tertiary">
        <span className="font-mono">#{live?.lastSeq ?? session.lastSeq}</span>
        <span>{session.origin.kind === 'fork' ? `分叉自 #${session.origin.atSeq}` : '从任务派生'}</span>
      </footer>

      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-strong" />
    </div>
  );
}

const TASK_ACTION =
  'rounded-sm border border-hair px-1.5 py-0.5 text-meta text-tertiary transition-opacity hover:border-accent hover:text-accent focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

export function TaskCard({ data, selected }: NodeProps<TaskNode>) {
  const { task, sessionCount, onStatus, onDetail, onDerive, onResized } = data;
  const muted = task.status === 'abandoned';
  // 「试过是死路」和「还在试」必须能区分（S4.2），所以收尾与放弃是两个动作，重开也留着。
  // 卡片上只放两个下一步（进行中时仍是「收尾 / 放弃」这对 S4.2 的动作）；完整的在详情抽屉里。
  const actions =
    task.status === 'in_progress'
      ? NEXT_STATUS.in_progress.filter((action) => action.next === 'done' || action.next === 'abandoned')
      : NEXT_STATUS[task.status].slice(0, 2);
  return (
    <div
      // 派生会话只走「＋ 会话」按钮，不再有双击快捷方式（双击留给以后「放大到这个任务」）。
      className={`group h-full w-full overflow-hidden rounded-md border bg-panel px-3 py-2 hover:border-accent ${
        selected ? 'border-accent' : 'border-hair'
      } ${muted ? 'opacity-60' : ''}`}
    >
      <CardResizer kind="task" selected={selected} onResized={onResized} />
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-meta text-tertiary">任务</span>
        <TaskBadge status={task.status} />
      </div>
      <p className={`text-body ${muted ? 'text-tertiary line-through' : 'text-primary'}`}>{task.title}</p>
      {task.goal ? <p className="mt-1 line-clamp-2 text-meta text-tertiary">{task.goal}</p> : null}
      {task.summary ? (
        <p className="mt-1 line-clamp-2 text-meta text-secondary" data-testid="task-card-summary">
          <span className="text-accent">▸</span> {task.summary}
        </p>
      ) : null}
      <p className="mt-1.5 font-mono text-meta text-tertiary">
        {sessionCount} 个会话{task.logSeq > 0 ? ` · ${task.logSeq} 条日志` : ''}
        {sessionCount === 0 ? <span className="ml-1 text-tertiary/70">· 点「＋ 会话」开一条</span> : null}
      </p>
      {/* 「＋ 会话」「日志」常驻（桌面上淡一点，悬停/选中/键盘聚焦时变亮）——藏在悬停里太难发现；
          状态动作是次要的，桌面上仍只在悬停/聚焦时出现，触屏一律常驻。 */}
      <div className="nodrag mt-1.5 flex flex-wrap gap-1" data-testid="task-card-actions">
        <button
          className={`${TASK_ACTION} ${selected ? '' : 'pointer-fine:opacity-70 pointer-fine:group-hover:opacity-100'}`}
          onClick={(event) => {
            event.stopPropagation();
            onDerive();
          }}
        >
          ＋ 会话
        </button>
        <button
          className={`${TASK_ACTION} ${selected ? '' : 'pointer-fine:opacity-70 pointer-fine:group-hover:opacity-100'}`}
          onClick={(event) => {
            event.stopPropagation();
            onDetail();
          }}
        >
          日志
        </button>
        {actions.map((action) => (
          <button
            key={action.next}
            className={`${TASK_ACTION} ${selected ? '' : 'pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100'}`}
            onClick={(event) => {
              event.stopPropagation();
              onStatus(action.next);
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-strong" />
    </div>
  );
}

/** 一台 worker 一个框：框住这个项目里跑在它上面的会话。只有标题栏能拖（拖框 = 框里的卡一起走），框身不挡平移。 */
export type FrameNode = Node<
  {
    readonly label: string;
    readonly online: boolean | null;
    readonly count: number;
    readonly resources?: WorkerInfoDto['resources'];
  },
  'frame'
>;

export function WorkerFrame({ data }: NodeProps<FrameNode>) {
  const state = data.online === null ? '状态未知' : data.online ? '在线' : '离线';
  return (
    <div
      data-testid="worker-frame"
      className="pointer-events-none h-full w-full rounded-lg border border-dashed border-strong bg-card/20"
    >
      <div
        data-testid="worker-frame-handle"
        title="按住拖动整个框"
        className="frame-handle pointer-events-auto flex h-9 cursor-grab select-none items-center gap-2 rounded-t-lg border-b border-dashed border-hair px-3"
      >
        <span aria-hidden className="text-meta text-tertiary">⠿</span>
        <span className="truncate text-head text-primary">{data.label}</span>
        <span
          data-testid="worker-frame-state"
          className={`flex shrink-0 items-center gap-1 text-meta ${data.online ? 'text-sage' : 'text-tertiary'}`}
        >
          <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${data.online ? 'bg-sage' : 'bg-tertiary'}`} />
          {state}
        </span>
        <ResourceBadge resources={data.resources} />
        <span className="ml-auto shrink-0 text-meta text-tertiary">{data.count} 个会话</span>
      </div>
    </div>
  );
}
