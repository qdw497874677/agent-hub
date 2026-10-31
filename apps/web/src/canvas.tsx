import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  ReactFlow,
  type Edge,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance
} from '@xyflow/react';
import type { CanvasDto, SaveLayoutRequest, TaskDto } from './api.ts';
import { resolveLive, type LiveMap } from './live.ts';
import { SessionCard, TaskCard, WorkerFrame, type FrameNode, type SessionNode, type TaskNode } from './nodes.tsx';
type AnyNode = TaskNode | SessionNode | FrameNode;
import { CARD_LIMITS, cardWidth, clampSize, type Size } from './card-size.ts';
import { openingViewport, panIntoView } from './viewport.ts';
import { arrange, frameGroups, frameRect, landsInForeignFrame, placeMissing, shiftFrame, type Rect } from './layout.ts';
import { resolveWorker, useWorkers } from './workers.tsx';
import { workspaceName } from './workspace-chooser.tsx';
import { CanvasWindowLayer, useCanvasWindows } from './canvas-window-layer.tsx';
import { useNarrow } from './device.ts';

const nodeTypes: NodeTypes = { session: SessionCard, task: TaskCard, frame: WorkerFrame };

type Point = { x: number; y: number };

/** 一次布局变更，只带变了的节点；服务端按节点合并。 */
export type LayoutPatch = SaveLayoutRequest;

interface Props {
  readonly canvas: CanvasDto;
  readonly live: LiveMap;
  readonly onDerive: (taskId: string) => void;
  /** 打开专注对话：一条会话，整屏看。 */
  readonly onOpen: (sessionId: string) => void;
  /** 窗口里发完消息、分叉后刷新画布。 */
  readonly onChanged: () => void;
  /** 卡片上的输入行：草稿存在 App 层，切视图不丢（S6.4）。 */
  readonly drafts: Readonly<Record<string, string>>;
  readonly onDraftChange: (sessionId: string, text: string) => void;
  readonly onSend: (sessionId: string, text: string) => Promise<void>;
  readonly onInterrupt: (sessionId: string) => Promise<void>;
  /** 改 agent 的可调项（模型、思考强度…）：清单由 agent 报，我们只转发。 */
  readonly onChangeOption: (sessionId: string, optionId: string, value: string | boolean) => Promise<void>;
  readonly onLayoutChange: (patch: LayoutPatch) => void;
  readonly onTaskStatus: (taskId: string, status: TaskDto['status']) => void;
  readonly onTaskDetail: (taskId: string) => void;
  /** 搜索命中后跳到这里：nonce 变化就重新居中（同一条命中点两次也要动）。 */
  readonly focus: { readonly id: string; readonly nonce: number } | null;
}

/** 没量到、没拖过的卡按上限估高度：宁可留白，也不压到邻居（会话卡未拖时输出区最高 320px）。 */
const ESTIMATE: Record<'task' | 'session', number> = { task: 160, session: 480 };


const FIT = { padding: 0.12, minZoom: 0.55, maxZoom: 1 };

/**
 * 打开时适配视口。要等卡片量出真实尺寸再算（最多等约半秒），
 * 规则见 openingViewport：手机上放不下就左上对齐，不再居中把开头推到屏幕外。
 */
function fitOnOpen(
  instance: Pick<ReactFlowInstance<AnyNode, Edge>, 'getNodes' | 'getNodesBounds' | 'setViewport'>,
  element: HTMLElement | null,
  frames = 30
): void {
  const nodes = instance.getNodes();
  const measured = nodes.length > 0 && nodes.every((node) => node.measured?.width);
  if (!measured && frames > 0) {
    requestAnimationFrame(() => fitOnOpen(instance, element, frames - 1));
    return;
  }
  if (!element || nodes.length === 0) return;
  const screen = { width: element.clientWidth, height: element.clientHeight };
  void instance.setViewport(openingViewport(instance.getNodesBounds(nodes), screen, FIT));
}

export function CanvasView({
  canvas,
  live,
  onDerive,
  onOpen,
  onChanged,
  onLayoutChange,
  onTaskStatus,
  onTaskDetail,
  focus,
  drafts,
  onDraftChange,
  onSend,
  onInterrupt,
  onChangeOption
}: Props) {
  // setCenter 只需要视口能力，用 Pick 而不是整个实例，免得节点泛型跟着穿进来
  const flow = useRef<Pick<
    ReactFlowInstance<AnyNode, Edge>,
    'setCenter' | 'getViewport' | 'setViewport' | 'getNode' | 'getInternalNode'
  > | null>(null);
  const flowFit = useRef<ReactFlowInstance<AnyNode, Edge>['fitView'] | null>(null);
  const [sizes, setSizes] = useState<Record<string, Size>>(() => ({ ...canvas.layout.sizes }));
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  // 卡片尺寸：拖过的 > 量到的 > 按上限估。排布全靠它，不再用固定格子。
  const sizeOf = useCallback(
    (id: string): Size => {
      const kind = canvas.tasks.some((task) => task.id === id) ? 'task' : 'session';
      const saved = sizesRef.current[id];
      const measured = flow.current?.getInternalNode(id)?.measured;
      return {
        width: saved?.width ?? measured?.width ?? CARD_LIMITS[kind].defaultWidth,
        height: saved?.height ?? measured?.height ?? ESTIMATE[kind]
      };
    },
    [canvas.tasks]
  );
  // 存过的位置原样用；其余（没拖过的、后来才出现的派生/分叉/新任务）按树形排布放，压到别人就往下挪。
  const [positions, setPositions] = useState<Record<string, Point>>(() =>
    placeMissing(canvas.layout.positions, arrange(canvas, sizeOf), sizeOf)
  );
  useEffect(() => setPositions((current) => placeMissing(current, arrange(canvas, sizeOf), sizeOf)), [canvas, sizeOf]);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  // 同一台 worker 的会话一个框。框的位置由框里的卡推出来（卡的位置照常存库），所以框的位置天然跟着存。
  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [key, members] of frameGroups(canvas.sessions)) map.set(key, members.map((session) => session.id));
    return map;
  }, [canvas.sessions]);
  const frameOfSession = useMemo(() => {
    const map = new Map<string, string>();
    for (const [key, ids] of groups) for (const id of ids) map.set(id, key);
    return map;
  }, [groups]);
  const dragStart = useRef<{ id: string; point: Point } | null>(null);
  // 「整理布局」：唯一会动用户拖过的位置的入口，按真实尺寸整体重排并存库。
  const tidy = useCallback(() => {
    const next = arrange(canvas, sizeOf);
    setPositions(next);
    onLayoutChange({ positions: next });
    requestAnimationFrame(() => void flowFit.current?.({ duration: 300 }));
  }, [canvas, sizeOf, onLayoutChange]);
  // 选中态自己管：节点是由数据推出来的受控节点，React Flow 的选中/拖动/缩放都以 change 的形式交回来。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  // 展开成画布窗口（双击会话卡 / ⤢ / 右键）：多个并排看，状态存在本机浏览器
  const narrow = useNarrow();
  const windows = useCanvasWindows(canvas, container, narrow);
  const { expand, expanded } = windows;
  // 刚点选的卡：右栏展开会把画布挤窄，挤完之后再把它整个挪进视口。
  const revealing = useRef<{ id: string; until: number } | null>(null);

  const reveal = useCallback((nodeId: string) => {
    const instance = flow.current;
    const element = container.current;
    const node = instance?.getNode(nodeId);
    if (!instance || !element || !node) return;
    const rect = {
      x: node.position.x,
      y: node.position.y,
      width: node.measured?.width ?? node.width ?? 320,
      height: node.measured?.height ?? node.height ?? 240
    };
    const current = instance.getViewport();
    const next = panIntoView(current, rect, { width: element.clientWidth, height: element.clientHeight });
    if (next !== current) void instance.setViewport(next, { duration: 200 });
  }, []);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const pending = revealing.current;
      if (pending && Date.now() < pending.until) reveal(pending.id);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [reveal]);

  // 画布可能比节点先渲染完，所以居中放在这里而不是点击时——点击时 flow 还不存在。
  useEffect(() => {
    if (!focus) return;
    const point = positions[focus.id];
    if (!point || !flow.current) return;
    const width = cardWidth(canvas.sessions.some((session) => session.id === focus.id) ? 'session' : 'task', sizes[focus.id]);
    flow.current.setCenter(point.x + width / 2, point.y + 120, { zoom: 1, duration: 400 });
  }, [focus, positions, sizes, canvas.sessions]);

  const workers = useWorkers();
  const placeOf = useCallback(
    (workspaceId: string | null | undefined, workerId: string | null) => {
      const workspace = workspaceId ? canvas.workspaces.find((item) => item.id === workspaceId) : undefined;
      if (!workspace) return undefined;
      const machine = resolveWorker(workers.list, workspace.workerId ?? workerId)?.label ?? '本机';
      return {
        machine,
        workspace: workspaceName(workspace),
        path: workspace.path,
        branch: workspace.branch,
        kept: workspace.state === 'kept' ? (workspace.keptReason ?? '有未保存的改动') : null
      };
    },
    [canvas.workspaces, workers.list]
  );
  const workerOf = useCallback(
    (workerId: string | null) => (workers.multi ? resolveWorker(workers.list, workerId) : undefined),
    [workers.multi, workers.list]
  );

  const agentLabel = useCallback(
    (agentId: string) => canvas.agents.find((agent) => agent.id === agentId)?.label ?? agentId,
    [canvas.agents]
  );

  /** 缩放结束：左/上边的把手会同时挪原点，所以位置和尺寸一起存。 */
  const resized = useCallback(
    (kind: 'task' | 'session', nodeId: string) =>
      ({ x, y, width, height }: Size & Point) => {
        const point = { x, y };
        const size = clampSize(kind, { width, height });
        setPositions((current) => ({ ...current, [nodeId]: point }));
        setSizes((current) => ({ ...current, [nodeId]: size }));
        onLayoutChange({ positions: { [nodeId]: point }, sizes: { [nodeId]: size } });
      },
    [onLayoutChange]
  );

  // React Flow 量到的尺寸。受控节点每次重建都是新对象，不带 measured 的话 React Flow 会把它当「没量过」、
  // 给节点挂 visibility:hidden，要等 ResizeObserver 再报一次——尺寸没变就永远不报，卡片整张隐身
  // （流式输出时一次重渲染落在最后一次测量之后就会这样；e2e 偶发的「hidden」就是它）。所以量到的要记下来、喂回去。
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  /** 只吃我们关心的变化：选中、拖动中的位置、缩放中的尺寸，以及测量结果（喂回节点，见上）。 */
  const onNodesChange = useCallback((changes: NodeChange<AnyNode>[]) => {
    for (const change of changes) {
      if (change.type === 'dimensions' && change.dimensions) {
        const { width, height } = change.dimensions;
        setMeasured((current) =>
          current[change.id]?.width === width && current[change.id]?.height === height ? current : { ...current, [change.id]: { width, height } }
        );
      }
      if (change.type === 'select') {
        setSelectedId((current) => (change.selected ? change.id : current === change.id ? null : current));
      } else if (change.type === 'position' && change.position && groups.has(change.id)) {
        // 拖框：框里的卡一起平移
        const point = change.position;
        const ids = groups.get(change.id) ?? [];
        setPositions((current) => {
          const rect = frameRect(ids, current, sizeOf);
          return rect ? shiftFrame(current, ids, { x: point.x - rect.x, y: point.y - rect.y }) : current;
        });
      } else if (change.type === 'position' && change.position) {
        const point = change.position;
        setPositions((current) => ({ ...current, [change.id]: point }));
      } else if (change.type === 'dimensions' && change.resizing && change.dimensions) {
        const size = change.dimensions;
        setSizes((current) => ({ ...current, [change.id]: size }));
      }
    }
  }, [groups, sizeOf]);

  const nodes = useMemo(() => {
    const box = (kind: 'task' | 'session', nodeId: string) => {
      const size = sizes[nodeId];
      const seen = measured[nodeId];
      return {
        width: size?.width ?? CARD_LIMITS[kind].defaultWidth,
        height: size?.height,
        selected: nodeId === selectedId,
        ...(seen ? { measured: seen } : {})
      };
    };
    const taskNodes: TaskNode[] = canvas.tasks.map((task) => ({
      id: task.id,
      type: 'task',
      position: positions[task.id] ?? { x: 0, y: 0 },
      ...box('task', task.id),
      data: {
        task,
        size: sizes[task.id],
        onResized: resized('task', task.id),
        sessionCount: canvas.sessions.filter((s) => s.taskId === task.id).length,
        onStatus: (status: TaskDto['status']) => onTaskStatus(task.id, status),
        onDetail: () => onTaskDetail(task.id),
        onDerive: () => onDerive(task.id)
      }
    }));
    const sessionNodes: SessionNode[] = canvas.sessions.map((session) => ({
      id: session.id,
      type: 'session',
      position: positions[session.id] ?? { x: 0, y: 0 },
      // 交互分区（docs/guide.md「画布交互」）：会话卡只能按住顶栏拖；对话区滚动、输入区打字，互不抢。
      dragHandle: '.card-drag-zone',
      ...box('session', session.id),
      data: {
        session,
        size: sizes[session.id],
        onResized: resized('session', session.id),
        live: resolveLive(session, canvas.previews[session.id] ?? [], live[session.id]) ?? undefined,
        agentLabel: agentLabel(session.agentId),
        worker: workerOf(session.workerId),
        resources: resolveWorker(workers.list, session.workerId)?.resources,
        place: placeOf(session.workspaceId, session.workerId),
        onOpen: () => onOpen(session.id),
        onExpand: () => expand(session.id),
        expanded: expanded(session.id),
        draft: drafts[session.id] ?? '',
        onDraftChange: (text: string) => onDraftChange(session.id, text),
        onSend: (text: string) => onSend(session.id, text),
        onInterrupt: () => onInterrupt(session.id),
        onChangeOption: (optionId: string, value: string | boolean) => onChangeOption(session.id, optionId, value)
      }
    }));
    const frameNodes: FrameNode[] = [...groups].flatMap(([key, ids]) => {
      const rect = frameRect(ids, positions, sizeOf);
      if (!rect) return [];
      const raw = key.slice('frame:'.length);
      const worker = resolveWorker(workers.list, raw === 'local' ? null : raw);
      return [{
        id: key,
        type: 'frame',
        position: { x: rect.x, y: rect.y },
        width: rect.width,
        height: rect.height,
        // 尺寸是我们算出来的，直接当「量过」喂回去：不喂的话每次重建都被当成没量过、整框隐身（见上面 measured 的注释）
        measured: { width: rect.width, height: rect.height },
        style: { pointerEvents: 'none' },
        zIndex: -1,
        selectable: false,
        dragHandle: '.frame-handle',
        data: { label: worker?.label ?? (raw === 'local' ? '本机' : '未知机器'), online: worker ? worker.state === 'online' : null, count: ids.length, resources: worker?.resources }
      }];
    });
    // 框垫在最下面，卡片和连线画在框上
    return [...frameNodes, ...taskNodes, ...sessionNodes];
  }, [
    groups,
    sizeOf,
    workers.list,
    canvas.tasks,
    canvas.sessions,
    canvas.previews,
    positions,
    sizes,
    measured,
    selectedId,
    resized,
    live,
    drafts,
    agentLabel,
    workerOf,
    placeOf,
    onTaskStatus,
    onTaskDetail,
    onDerive,
    onOpen,
    expand,
    expanded,
    onDraftChange,
    onSend,
    onInterrupt
  ]);

  const edges = useMemo(() => {
    const derived: Edge[] = canvas.edges
      .filter((edge) => edge.kind === 'derive')
      .map((edge) => ({
        id: `derive-${edge.taskId}-${edge.sessionId}`,
        source: edge.taskId,
        target: edge.sessionId,
        type: 'smoothstep',
        style: { stroke: 'var(--color-strong)', strokeWidth: 1 }
      }));
    const forked: Edge[] = canvas.edges
      .filter((edge) => edge.kind === 'fork')
      .map((edge) => ({
        id: `fork-${edge.fromSessionId}-${edge.toSessionId}`,
        source: edge.fromSessionId,
        target: edge.toSessionId,
        type: 'smoothstep',
        label: `#${edge.atSeq}`,
        labelStyle: { fill: 'var(--color-sage)', fontSize: 11, fontFamily: 'var(--font-mono)' },
        labelBgStyle: { fill: 'var(--color-canvas)' },
        style: { stroke: 'var(--color-sage)', strokeWidth: 1, strokeDasharray: '6 4' }
      }));
    return [...derived, ...forked];
  }, [canvas.edges]);

  return (
    <div
      className="relative h-full w-full"
      ref={container}
      onPointerDownCapture={(event) => {
        pressedAt.current = { x: event.clientX, y: event.clientY };
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitViewOptions={FIT}
        proOptions={{ hideAttribution: true }}
        onInit={(instance) => {
          flow.current = instance;
          flowFit.current = instance.fitView;
          fitOnOpen(instance, container.current);
        }}
        onNodeClick={(event, node) => {
          if (node.type !== 'session') return;
          // 按下后挪过（在对话区里划选文字、滑动）就不算单击，不要选中再把画布拉过去
          const down = pressedAt.current;
          if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
          // 卡片里的输入框、按钮、选择器、链接各有各的事；点它们不算「打开这条会话」。
          if ((event.target as HTMLElement).closest('input, textarea, button, select, a, [role="menu"], [role="listbox"], .card-resize-handle')) return;
          // 单击只选中（边框高亮、拉进视野），不进会话：进会话要双击或点卡片上的「打开」。
          revealing.current = { id: node.id, until: Date.now() + 800 };
          setSelectedId(node.id);
          requestAnimationFrame(() => reveal(node.id));
        }}
        onNodesChange={onNodesChange}
        onNodeDragStart={(_, node) => {
          const point = positionsRef.current[node.id];
          dragStart.current = point ? { id: node.id, point } : null;
        }}
        onNodeDragStop={(_, node) => {
          if (node.type === 'frame') {
            const ids = groups.get(node.id) ?? [];
            const moved = Object.fromEntries(ids.flatMap((id) => (positionsRef.current[id] ? [[id, positionsRef.current[id]]] : [])));
            onLayoutChange({ positions: moved });
            return;
          }
          const point = { x: node.position.x, y: node.position.y };
          // worker 定死了：会话拖进别的 worker 的框就弹回原处
          const own = frameOfSession.get(node.id);
          if (own !== undefined) {
            const foreign = [...groups]
              .filter(([key]) => key !== own)
              .flatMap(([, ids]) => {
                const rect = frameRect(ids, positionsRef.current, sizeOf);
                return rect ? [rect as Rect] : [];
              });
            const start = dragStart.current;
            if (start?.id === node.id && landsInForeignFrame({ ...point, ...sizeOf(node.id) }, foreign)) {
              setPositions((current) => ({ ...current, [node.id]: start.point }));
              return;
            }
          }
          setPositions((current) => ({ ...current, [node.id]: point }));
          onLayoutChange({ positions: { [node.id]: point } });
        }}
        minZoom={0.35}
        maxZoom={1.4}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--color-hair)" />
        {/* 图例在左下角，控件放右下角：两者曾经叠在一起，图例被压成两行看不清的字 */}
        <Controls showInteractive={false} position="bottom-right">
          <ControlButton onClick={tidy} title="整理布局" aria-label="整理布局">
            ⊞
          </ControlButton>
          {windows.set.windows.length > 0 && !narrow ? (
            <ControlButton onClick={windows.retile} title="重新平铺窗口" aria-label="重新平铺窗口">
              ▦
            </ControlButton>
          ) : null}
        </Controls>
      </ReactFlow>
      <CanvasWindowLayer
        windows={windows}
        narrow={narrow}
        canvas={canvas}
        live={live}
        drafts={drafts}
        onDraftChange={onDraftChange}
        onChanged={onChanged}
        onOpen={onOpen}
        onChangeOption={onChangeOption}
      />
    </div>
  );
}

