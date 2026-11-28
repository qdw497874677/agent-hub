import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ModelPicker } from '../../atoms/model-picker.tsx';
import { workspaceName } from '../../atoms/workspace-format.ts';
import { api, providersApi, sessionGroupId, type CanvasDto, type SessionDto, type WorkspaceDto } from '../../shell/api.ts';
import { DialogShell, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';
import { modelsFor, withHubModels } from '../../shell/dialogs.tsx';
import { machineSelectable, startBlockReason } from '../../shell/harness-gate.ts';
import { resolveWorker, useWorkers } from '../../shell/workers.tsx';
import { useWorkspaceViews } from './workspace-chooser.tsx';
import type { WorkspaceGroupView } from './workspace-group.ts';

/** A new tab is a fresh session, never a derive/fork or an implicit worktree. */
export function SessionTabCreate({ canvas, source, workspace, onClose, onCreated, onUncertain }: {
  canvas: CanvasDto; source?: SessionDto; workspace?: WorkspaceDto; onClose: () => void; onCreated: (session: SessionDto) => void; onUncertain: () => void;
}) {
  const workers = useWorkers();
  const views = useWorkspaceViews(canvas.project.id);
  const [taskId, setTaskId] = useState(source?.taskId ?? '');
  const [agentId, setAgentId] = useState(source?.agentId ?? '');
  const [model, setModel] = useState('');
  const [workerId, setWorkerId] = useState(source?.workerId ?? workspace?.workerId ?? '');
  const groupId = sessionGroupId(source);
  const group = useQuery({ queryKey: ['workspace-group', groupId], queryFn: () => api.workspaceGroup(groupId!), enabled: !!groupId, retry: false });
  const initialWorkspaceId = workspace?.id ?? (!groupId ? source?.workspaceId : null);
  const [placement, setPlacement] = useState(groupId ? `group:${groupId}` : initialWorkspaceId ? `workspace:${initialWorkspaceId}` : '');
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const hub = useQuery({ queryKey: ['hub-models', taskId], queryFn: () => providersApi.modelsExplained(taskId), enabled: !!taskId, retry: false });
  const providers = hub.data?.providers ?? [];
  const agent = canvas.agents.find((item) => item.id === agentId);
  const worker = resolveWorker(workers.list, workerId || null);
  const offered = withHubModels(modelsFor(workers.list, workerId || null, agentId) ?? { models: agent?.models ?? [], defaultModel: agent?.defaultModel ?? '' }, workers.list, workerId || null, agentId, providers);
  const protocols = providers.filter((p) => p.models.length).map((p) => p.protocol);
  const modelProtocol = providers.find((p) => p.models.some((m) => m.id === model))?.protocol ?? null;
  const validMachine = !!workerId && machineSelectable(worker, agentId, protocols) && !startBlockReason(worker, agentId, model, modelProtocol);
  const machineId = (id: string | null) => id ?? workers.list.find((item) => item.origin === 'local')?.workerId ?? null;
  const dirs = (views.data ?? []).filter(({ workspace: item, ownerProjectId }) => !item.groupId && (item.state === 'ready' || item.state === 'kept') && machineId(item.workerId) === workerId && (item.kind === 'temporary' ? item.ownerTaskId === taskId && item.projectId === canvas.project.id : ownerProjectId === canvas.project.id));
  const currentGroup = group.data as (WorkspaceGroupView & { ownerTaskId?: string | null }) | undefined;
  const validGroup = !!currentGroup && currentGroup.projectId === canvas.project.id && currentGroup.ownerTaskId === taskId && currentGroup.state === 'ready' && machineId(currentGroup.workerId) === workerId && currentGroup.members.length > 0 && currentGroup.members.every((member) => member.state === 'ready' && (views.data ?? []).some(({ workspace: item }) => item.id === member.workspaceId && item.groupId === currentGroup.id && item.ownerTaskId === taskId && machineId(item.workerId) === workerId && (item.state === 'ready' || item.state === 'kept')));
  const validPlacement = placement === 'chat-only' || dirs.some(({ workspace: item }) => placement === `workspace:${item.id}`) || (validGroup && placement === `group:${currentGroup!.id}`);
  const submit = async () => {
    if (!taskId || !agentId || !validMachine || !validPlacement || pending || uncertain || locked.current) return;
    locked.current = true;
    const chosen = placement === 'chat-only' ? { kind: 'chat-only' as const } : placement.startsWith('group:') ? { kind: 'group' as const, groupId: placement.slice(6) } : { kind: 'workspace' as const, workspaceId: placement.slice(10) };
    setPending(true); setError('');
    let sent = false;
    try {
      const [freshCanvas, freshWorkers, freshViews, freshGroup] = await Promise.all([api.canvas(canvas.project.id), api.workers(), api.workspaces(canvas.project.id), chosen.kind === 'group' ? api.workspaceGroup(chosen.groupId) : Promise.resolve(null)]);
      if (!freshCanvas.tasks.some((task) => task.id === taskId && task.projectId === canvas.project.id && task.archivedAt == null)) throw new Error('任务不可用或已归档，请重新选择');
      if (!freshCanvas.agents.some((item) => item.id === agentId)) throw new Error('Agent 不可用，请重新选择');
      const freshWorker = resolveWorker(freshWorkers, workerId);
      if (!machineSelectable(freshWorker, agentId, protocols) || startBlockReason(freshWorker, agentId, model, modelProtocol)) throw new Error('机器或 Agent 当前不可用，请重新选择');
      const resolveId = (id: string | null) => id ?? freshWorkers.find((item) => item.origin === 'local')?.workerId ?? null;
      if (chosen.kind === 'workspace') {
        const view = freshViews.find(({ workspace: item }) => item.id === chosen.workspaceId);
        const item = view?.workspace;
        if (!item || item.groupId || (item.state !== 'ready' && item.state !== 'kept') || resolveId(item.workerId) !== workerId || (item.kind === 'temporary' ? item.ownerTaskId !== taskId || item.projectId !== canvas.project.id : view.ownerProjectId !== canvas.project.id)) throw new Error('工作目录不可用、归属不符或不在所选机器上');
      }
      if (chosen.kind === 'group') {
        const item = freshGroup as (WorkspaceGroupView & { ownerTaskId?: string | null }) | null;
        if (!item || item.projectId !== canvas.project.id || item.ownerTaskId !== taskId || item.state !== 'ready' || resolveId(item.workerId) !== workerId || !item.members.length || item.members.some((member) => member.state !== 'ready' || !freshViews.some(({ workspace: dir }) => dir.id === member.workspaceId && dir.groupId === item.id && dir.ownerTaskId === taskId && resolveId(dir.workerId) === workerId && (dir.state === 'ready' || dir.state === 'kept')))) throw new Error('组合工作目录或成员不可用、归属不符或不在所选机器上');
      }
      sent = true;
      const result = await api.createSessionTab(canvas.project.id, { taskId, agentId, ...(model ? { model } : {}), workerId, placement: chosen });
      onCreated(result);
    } catch (err) {
      // No idempotency key: an unknown response must never be retried automatically or by a second click.
      if (sent) { setUncertain(true); onUncertain(); setError(`创建结果待确认，请先检查项目会话列表，避免重复创建。${err instanceof Error ? ` ${err.message}` : ''}`); }
      else setError(err instanceof Error ? err.message : '无法确认当前配置，请稍后重试');
    } finally { locked.current = false; setPending(false); }
  };
  return <DialogShell title="新建会话" testId="session-tab-create" onClose={pending ? () => {} : onClose}>
    <div className="space-y-4">
      <p className="text-sub text-secondary">新会话不会继承当前对话，也不会创建 Worktree。</p>
      <label className="block text-meta text-secondary">任务<select aria-label="任务" className={`mt-1 ${INPUT}`} value={taskId} onChange={(e) => setTaskId(e.target.value)}><option value="">选择任务</option>{canvas.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
      <label className="block text-meta text-secondary">Agent<select aria-label="Agent" className={`mt-1 ${INPUT}`} value={agentId} onChange={(e) => { setAgentId(e.target.value); setModel(''); }}><option value="">选择 Agent</option>{canvas.agents.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <div className="text-meta text-secondary">模型<ModelPicker label="模型" className="mt-1" scope={`session-tab:${agentId}`} items={offered.models.map((item) => ({ value: item, label: item }))} value={model} onChange={setModel} placeholder="默认" /></div>
      <label className="block text-meta text-secondary">机器<select aria-label="机器" className={`mt-1 ${INPUT}`} value={workerId} onChange={(e) => { setWorkerId(e.target.value); setPlacement(''); setModel(''); }}><option value="">选择机器</option>{workers.list.map((item) => <option key={item.workerId} value={item.workerId} disabled={item.state !== 'online'}>{item.label}{item.state !== 'online' ? '（离线）' : ''}</option>)}</select></label>
      <label className="block text-meta text-secondary">工作位置<select aria-label="工作位置" className={`mt-1 ${INPUT}`} value={placement} onChange={(e) => setPlacement(e.target.value)}><option value="">选择工作位置</option><option value="chat-only">仅对话</option>{validGroup ? <option value={`group:${currentGroup!.id}`}>组合工作目录 · {currentGroup!.root}</option> : null}{dirs.map(({ workspace: item }) => <option key={item.id} value={`workspace:${item.id}`}>{workspaceName(item)} · {item.path}</option>)}</select></label>
      {placement && !validPlacement ? <p role="status" className="text-meta text-rust">原工作位置不可用于当前任务或机器，请重新选择。</p> : null}
      {views.isError ? <p role="status" className="text-meta text-rust">工作目录读取失败，请稍后重试。</p> : null}
      {error ? <p role="alert" className="text-meta text-rust">{error}</p> : null}
      <div className="flex justify-end gap-2"><button type="button" disabled={pending} className={SECONDARY_BUTTON} onClick={onClose}>{uncertain ? '返回会话' : '取消'}</button><button type="button" data-testid="session-tab-create-confirm" className={PRIMARY_BUTTON} disabled={!taskId || !agentId || !validMachine || !validPlacement || pending || uncertain} onClick={() => void submit()}>{pending ? '创建中…' : '创建会话'}</button></div>
    </div>
  </DialogShell>;
}
