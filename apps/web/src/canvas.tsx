import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance
} from '@xyflow/react';
import type { CanvasDto, SaveLayoutRequest, TaskDto } from './api.ts';
import { resolveLive, type LiveMap } from './live.ts';
import { SessionCard, TaskCard, type SessionNode, type TaskNode } from './nodes.tsx';
import { CARD_LIMITS, cardWidth, clampSize, type Size } from './card-size.ts';
import { panIntoView } from './viewport.ts';
import { fillMissing } from './layout.ts';

const nodeTypes: NodeTypes = { session: SessionCard, task: TaskCard };

type Point = { x: number; y: number };

/** 一次布局变更，只带变了的节点；服务端按节点合并。 */
export type LayoutPatch = SaveLayoutRequest;

interface Props {
  readonly canvas: CanvasDto;
  readonly live: LiveMap;
  readonly onSelect: (sessionId: string) => void;
  readonly onDerive: (taskId: string) => void;
  /** 打开专注对话：一条会话，整屏看。 */
  readonly onOpen: (sessionId: string) => void;
  /** 卡片上的输入行：草稿存在 App 层，切视图不丢（S6.4）。 */
  readonly drafts: Readonly<Record<string, string>>;
  readonly onDraftChange: (sessionId: string, text: string) => void;
  readonly onSend: (sessionId: string, text: string) => Promise<void>;
  readonly onInterrupt: (sessionId: string) => Promise<void>;
  /** 改 agent 的可调项（模型、思考强度…）：清单由 agent 报，我们只转发。 */
  readonly onChangeOption: (sessionId: string, optionId: string, value: string | boolean) => Promise<void>;
  readonly onLayoutChange: (patch: LayoutPatch) => void;
  readonly onTaskStatus: (taskId: string, status: TaskDto['status']) => void;
  /** 搜索命中后跳到这里：nonce 变化就重新居中（同一条命中点两次也要动）。 */
  readonly focus: { readonly id: string; readonly nonce: number } | null;
}

/**
 * 初始布局：任务一列往下排，每个任务的会话排在它右边、纵向堆叠。
 *
 * 之前是「任务两列 + 会话压在任务上方 130px 处」，卡片直接叠在一起——
 * 血缘线被卡片盖住，看图的人只能凭猜测。这里的取舍是：宁可画布很长要拖，
 * 也不要两张卡互相压着。
 */
const TASK_X = 80;
const TASK_WIDTH = 220;
const TASK_GAP = 80;
const SESSION_OFFSET_X = TASK_WIDTH + 96;
const SESSION_GAP_Y = 420;
const SESSION_COLUMN_WIDTH = 360;
const EMPTY_TASK_HEIGHT = 240;

function defaults(canvas: CanvasDto): Record<string, Point> {
  const placed: Record<string, Point> = {};
  let cursorY = 80;
  for (const task of canvas.tasks) {
    placed[task.id] = { x: TASK_X, y: cursorY };
    const sessions = canvas.sessions.filter((session) => session.taskId === task.id);
    sessions.forEach((session, index) => {
      placed[session.id] = {
        x: TASK_X + SESSION_OFFSET_X + (index % 2) * SESSION_COLUMN_WIDTH,
        y: cursorY + Math.floor(index / 2) * SESSION_GAP_Y
      };
    });
    const rows = Math.ceil(sessions.length / 2);
    cursorY += Math.max(EMPTY_TASK_HEIGHT, rows * SESSION_GAP_Y) + TASK_GAP;
  }
  return placed;
}

export function CanvasView({
  canvas,
  live,
  onSelect,
  onDerive,
  onOpen,
  onLayoutChange,
  onTaskStatus,
  focus,
  drafts,
  onDraftChange,
  onSend,
  onInterrupt,
  onChangeOption
}: Props) {
  const initial = useMemo(() => ({ ...defaults(canvas), ...canvas.layout.positions }), [canvas]);
  const [positions, setPositions] = useState<Record<string, Point>>(initial);
  // 挂载之后才出现的任务/会话（派生、分叉、新建）也要有位置，否则全叠在原点。
  useEffect(() => setPositions((current) => fillMissing(current, initial)), [initial]);
  const [sizes, setSizes] = useState<Record<string, Size>>(() => ({ ...canvas.layout.sizes }));
  // 选中态自己管：节点是由数据推出来的受控节点，React Flow 的选中/拖动/缩放都以 change 的形式交回来。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // setCenter 只需要视口能力，用 Pick 而不是整个实例，免得节点泛型跟着穿进来
  const flow = useRef<Pick<
    ReactFlowInstance<TaskNode | SessionNode, Edge>,
    'setCenter' | 'getViewport' | 'setViewport' | 'getNode'
  > | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
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

  /** 只吃我们关心的三种变化：选中、拖动中的位置、缩放中的尺寸。其余（测量等）交给 React Flow 自己。 */
  const onNodesChange = useCallback((changes: NodeChange<TaskNode | SessionNode>[]) => {
    for (const change of changes) {
      if (change.type === 'select') {
        setSelectedId((current) => (change.selected ? change.id : current === change.id ? null : current));
      } else if (change.type === 'position' && change.position) {
        const point = change.position;
        setPositions((current) => ({ ...current, [change.id]: point }));
      } else if (change.type === 'dimensions' && change.resizing && change.dimensions) {
        const size = change.dimensions;
        setSizes((current) => ({ ...current, [change.id]: size }));
      }
    }
  }, []);

  const nodes = useMemo(() => {
    const box = (kind: 'task' | 'session', nodeId: string) => {
      const size = sizes[nodeId];
      return { width: size?.width ?? CARD_LIMITS[kind].defaultWidth, height: size?.height, selected: nodeId === selectedId };
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
        onDerive: () => onDerive(task.id)
      }
    }));
    const sessionNodes: SessionNode[] = canvas.sessions.map((session) => ({
      id: session.id,
      type: 'session',
      position: positions[session.id] ?? { x: 0, y: 0 },
      ...box('session', session.id),
      data: {
        session,
        size: sizes[session.id],
        onResized: resized('session', session.id),
        live: resolveLive(session, canvas.previews[session.id] ?? [], live[session.id]) ?? undefined,
        agentLabel: agentLabel(session.agentId),
        onOpen: () => onOpen(session.id),
        draft: drafts[session.id] ?? '',
        onDraftChange: (text: string) => onDraftChange(session.id, text),
        onSend: (text: string) => onSend(session.id, text),
        onInterrupt: () => onInterrupt(session.id),
        onChangeOption: (optionId: string, value: string | boolean) => onChangeOption(session.id, optionId, value)
      }
    }));
    return [...taskNodes, ...sessionNodes];
  }, [
    canvas.tasks,
    canvas.sessions,
    canvas.previews,
    positions,
    sizes,
    selectedId,
    resized,
    live,
    drafts,
    agentLabel,
    onTaskStatus,
    onDerive,
    onOpen,
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
    <div className="h-full w-full" ref={container}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.12, minZoom: 0.55, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        onInit={(instance) => {
          flow.current = instance;
        }}
        onNodeClick={(_, node) => {
          if (node.type !== 'session') return;
          revealing.current = { id: node.id, until: Date.now() + 800 };
          onSelect(node.id);
          requestAnimationFrame(() => reveal(node.id));
        }}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, node) => {
          const point = { x: node.position.x, y: node.position.y };
          setPositions((current) => ({ ...current, [node.id]: point }));
          onLayoutChange({ positions: { [node.id]: point } });
        }}
        minZoom={0.35}
        maxZoom={1.4}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--color-hair)" />
        {/* 图例在左下角，控件放右下角：两者曾经叠在一起，图例被压成两行看不清的字 */}
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}

export { defaults as defaultPositions };
