import { useCallback, useMemo, useState } from 'react';
import { Background, BackgroundVariant, Controls, ReactFlow, type Edge, type NodeTypes } from '@xyflow/react';
import type { CanvasDto } from './api.ts';
import type { LiveMap } from './live.ts';
import { SessionCard, TaskCard, type SessionNode, type TaskNode } from './nodes.tsx';

const nodeTypes: NodeTypes = { session: SessionCard, task: TaskCard };

type Point = { x: number; y: number };

interface Props {
  readonly canvas: CanvasDto;
  readonly live: LiveMap;
  readonly onSelect: (sessionId: string) => void;
  readonly onDerive: (taskId: string) => void;
  readonly onLayoutChange: (positions: Record<string, Point>) => void;
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

export function CanvasView({ canvas, live, onSelect, onDerive, onLayoutChange }: Props) {
  const initial = useMemo(() => ({ ...defaults(canvas), ...canvas.layout.positions }), [canvas]);
  const [positions, setPositions] = useState<Record<string, Point>>(initial);

  const agentLabel = useCallback(
    (agentId: string) => canvas.agents.find((agent) => agent.id === agentId)?.label ?? agentId,
    [canvas.agents]
  );

  const nodes = useMemo(() => {
    const taskNodes: TaskNode[] = canvas.tasks.map((task) => ({
      id: task.id,
      type: 'task',
      position: positions[task.id] ?? { x: 0, y: 0 },
      data: { task, sessionCount: canvas.sessions.filter((s) => s.taskId === task.id).length }
    }));
    const sessionNodes: SessionNode[] = canvas.sessions.map((session) => ({
      id: session.id,
      type: 'session',
      position: positions[session.id] ?? { x: 0, y: 0 },
      data: { session, live: live[session.id], agentLabel: agentLabel(session.agentId) }
    }));
    return [...taskNodes, ...sessionNodes];
  }, [canvas.tasks, canvas.sessions, positions, live, agentLabel]);

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
