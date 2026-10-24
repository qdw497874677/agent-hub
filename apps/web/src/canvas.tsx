import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type NodeTypes,
  type ReactFlowInstance
} from '@xyflow/react';
import type { CanvasDto, TaskDto } from './api.ts';
import { resolveLive, type LiveMap } from './live.ts';
import { SessionCard, TaskCard, type SessionNode, type TaskNode } from './nodes.tsx';

const nodeTypes: NodeTypes = { session: SessionCard, task: TaskCard };

type Point = { x: number; y: number };

interface Props {
  readonly canvas: CanvasDto;
  readonly live: LiveMap;
  readonly onSelect: (sessionId: string) => void;
  readonly onDerive: (taskId: string) => void;
  readonly onLayoutChange: (positions: Record<string, Point>) => void;
  readonly onTaskStatus: (taskId: string, status: TaskDto['status']) => void;
  /** 搜索命中后跳到这里：nonce 变化就重新居中（同一条命中点两次也要动）。 */
  readonly focus: { readonly id: string; readonly nonce: number } | null;
}

function defaults(canvas: CanvasDto): Record<string, Point> {
  const placed: Record<string, Point> = {};
  canvas.tasks.forEach((task, taskIndex) => {
    const row = Math.floor(taskIndex / 2);
    const column = taskIndex % 2;
    const originX = 80 + column * 760;
    const originY = 80 + row * 560;
    placed[task.id] = { x: originX, y: originY };
    canvas.sessions
      .filter((session) => session.taskId === task.id)
      .forEach((session, index) => {
        placed[session.id] = { x: originX + 40 + (index % 2) * 340, y: originY + 130 + Math.floor(index / 2) * 260 };
      });
  });
  return placed;
}

export function CanvasView({ canvas, live, onSelect, onDerive, onLayoutChange, onTaskStatus, focus }: Props) {
  const initial = useMemo(() => ({ ...defaults(canvas), ...canvas.layout.positions }), [canvas]);
  const [positions, setPositions] = useState<Record<string, Point>>(initial);
  // setCenter 只需要视口能力，用 Pick 而不是整个实例，免得节点泛型跟着穿进来
  const flow = useRef<Pick<ReactFlowInstance<TaskNode | SessionNode, Edge>, 'setCenter'> | null>(null);

  // 画布可能比节点先渲染完，所以居中放在这里而不是点击时——点击时 flow 还不存在。
  useEffect(() => {
    if (!focus) return;
    const point = positions[focus.id];
    if (!point || !flow.current) return;
    const width = canvas.sessions.some((session) => session.id === focus.id) ? 320 : 220;
    flow.current.setCenter(point.x + width / 2, point.y + 120, { zoom: 1, duration: 400 });
  }, [focus, positions, canvas.sessions]);

  const agentLabel = useCallback(
    (agentId: string) => canvas.agents.find((agent) => agent.id === agentId)?.label ?? agentId,
    [canvas.agents]
  );

  const nodes = useMemo(() => {
    const taskNodes: TaskNode[] = canvas.tasks.map((task) => ({
      id: task.id,
      type: 'task',
      position: positions[task.id] ?? { x: 0, y: 0 },
      data: {
        task,
        sessionCount: canvas.sessions.filter((s) => s.taskId === task.id).length,
        onStatus: (status: TaskDto['status']) => onTaskStatus(task.id, status)
      }
    }));
    const sessionNodes: SessionNode[] = canvas.sessions.map((session) => ({
      id: session.id,
      type: 'session',
      position: positions[session.id] ?? { x: 0, y: 0 },
      data: {
        session,
        live: resolveLive(session, canvas.previews[session.id] ?? [], live[session.id]) ?? undefined,
        agentLabel: agentLabel(session.agentId)
      }
    }));
    return [...taskNodes, ...sessionNodes];
  }, [canvas.tasks, canvas.sessions, canvas.previews, positions, live, agentLabel, onTaskStatus]);

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
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        onInit={(instance) => {
          flow.current = instance;
        }}
        onNodeClick={(_, node) => {
          if (node.type === 'session') onSelect(node.id);
        }}
        onNodeDoubleClick={(_, node) => {
          if (node.type === 'task') onDerive(node.id);
        }}
        onNodeDragStop={(_, node) => {
          const next = { ...positions, [node.id]: { x: node.position.x, y: node.position.y } };
          setPositions(next);
          onLayoutChange(next);
        }}
        minZoom={0.35}
        maxZoom={1.4}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--color-hair)" />
        <Controls showInteractive={false} className="!bg-panel !border-hair" />
      </ReactFlow>
    </div>
  );
}

export { defaults as defaultPositions };
