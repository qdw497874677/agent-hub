import { createHash } from 'node:crypto';
import { asAgentId, buildAgentHandoffHistory, deriveSession, newId, ok, err, type AgentDescriptor, type AgentHandoffDeliveryEvidence, type AgentHandoffStore, type AgentHandoffRecord, type DomainError, type JournalEntry, type Principal, type PromptAck, type Result, type Session, type Task, type Workspace } from '@agent-hub/domain';

type Answer<T> = Result<T, DomainError>;
type SessionPermission = 'session.read' | 'session.continue' | 'session.prompt';
export interface AgentHandoffDeps {
  readonly store: AgentHandoffStore;
  session(id: string): Promise<Session | null>;
  task(id: string): Promise<Task | null>;
  workspace(id: string): Promise<Workspace | null>;
  /** Must resolve the current project/session ACL, not merely ownership. */
  sessionAllowed(actor: Principal, session: Session, permission: SessionPermission): Promise<boolean>;
  taskCreateAllowed(actor: Principal, task: Task): Promise<boolean>;
  /** Live task and project availability, including deletion/archive, checked even on replay. */
  taskActive(task: Task): Promise<boolean>;
  workspaceReady(task: Task, workspace: Workspace): Promise<boolean>;
  workerUseAllowed(actor: Principal, workerId: string): Promise<boolean>;
  /** Return descriptors only for the exact currently connected, ready worker. */
  readyDescriptors(workerId: string): Promise<readonly AgentDescriptor[] | null>;
  /** Existing Hub provider policy, including provider-backed models; absence denies. */
  providerAllowed?(actor: Principal, workerId: string, descriptor: AgentDescriptor, model: string): Promise<boolean>;
  /** Bounded ascending entries and exact durable delivery evidence, for this inclusive cursor. */
  history(sourceId: string, inclusiveCursor: number): Promise<{ entries: readonly JournalEntry[]; deliveries: readonly AgentHandoffDeliveryEvidence[] }>;
  /** null means unknown; never substitute a guessed window. */
  targetWindow(workerId: string, agentId: string, model: string): Promise<number | null>;
  /** Current startup evidence, not a promise that the model has answered. */
  startupState?(record: AgentHandoffRecord): AgentHandoffRecord['startup']['state'];
  firstCompleted?(record: AgentHandoffRecord): Promise<boolean>;
  now(): number;
  /** Called only after a new durable admission; owns stream notification and startup claim. */
  onAdmitted(record: AgentHandoffRecord): Promise<void>;
}

const error = (code: DomainError['code'], message: string) => err({ code, message });
const conflict = (message = '交接状态冲突，请重新核对') => error('conflict', message);
const invalid = (message = '参数不合法') => error('invalid', message);
const denied = () => error('forbidden', '无权执行交接');
const small = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '' && Buffer.byteLength(s) <= 512;
const hash = (fields: readonly unknown[]) => createHash('sha256').update(JSON.stringify(fields)).digest('hex');
const human = (p: Principal | null): p is Principal => !!p && !p.via && small(p.user.id);
const offers = (d: AgentDescriptor, agent: string, model: string) => d.id === agent && d.nativeHandoff === true && d.capabilities?.prompt?.state !== undefined && d.capabilities.prompt.state !== 'denied' && d.models.includes(model);
/** Operational limit for unknown windows, not a model context-size claim. */
export const AGENT_HANDOFF_UNKNOWN_WINDOW_MAX_BYTES = 64 * 1024;

export function createAgentHandoffService(deps: AgentHandoffDeps) {
  async function readPair(actor: Principal, record: AgentHandoffRecord): Promise<{ source: Session; target: Session } | null> {
    if (record.reservation.actorId !== actor.user.id) return null;
    const [source, target] = await Promise.all([deps.session(record.reservation.sourceSessionId), deps.session(record.reservation.target.id)]);
    if (!source || !target || !await deps.sessionAllowed(actor, source, 'session.read') || !await deps.sessionAllowed(actor, target, 'session.read')) return null;
    return { source, target };
  }
  async function projection(record: AgentHandoffRecord, text: string) {
    const r = record.reservation;
    const window = await deps.targetWindow(r.workerId, r.targetAgent, r.targetModel);
    if (window === null) return null;
    const source = await deps.history(r.sourceSessionId, r.sourceCursor);
    return buildAgentHandoffHistory({ sourceSessionId: r.sourceSessionId, cursor: r.sourceCursor, entries: source.entries, deliveries: source.deliveries, windowTokens: window, currentText: text });
  }
  return {
    async reserve(actor: Principal | null, sourceId: string, input: { agentId: string; model: string; requestId: string }): Promise<Answer<{ sessionId: string }>> {
      if (!human(actor)) return denied();
      if (!small(sourceId) || !small(input.agentId) || !small(input.model) || !small(input.requestId) || input.agentId !== input.agentId.trim() || input.model !== input.model.trim()) return invalid();
      const source = await deps.session(sourceId);
      if (!source) return error('not_found', '会话不存在');
      if (!await deps.sessionAllowed(actor, source, 'session.read') || !await deps.sessionAllowed(actor, source, 'session.continue')) return denied();
      if (!source.taskId || !source.workspaceId || !source.workerId || source.groupId != null || source.botId != null || source.parentSessionId != null || (source.kind ?? 'chat') !== 'chat' || source.agentId === input.agentId) return conflict();
      const [task, workspace] = await Promise.all([deps.task(source.taskId), deps.workspace(source.workspaceId)]);
      if (!task || !workspace || task.id !== source.taskId || workspace.id !== source.workspaceId || task.parentTaskId != null || task.archivedAt != null || task.status === 'abandoned' || workspace.groupId != null || workspace.workerId !== source.workerId || !workspace.path || !['ready', 'kept'].includes(workspace.state)) return conflict();
      if (!await deps.taskActive(task) || !await deps.taskCreateAllowed(actor, task) || !await deps.workerUseAllowed(actor, source.workerId)) return denied();
      const semanticHash = hash([source.id, input.agentId, input.model]);
      const replay = async (record: AgentHandoffRecord): Promise<Answer<{ sessionId: string }>> => {
        const r = record.reservation;
        if (r.actorId !== actor.user.id || r.sourceSessionId !== source.id || r.requestKey !== input.requestId || r.semanticHash !== semanticHash || r.targetAgent !== input.agentId || r.targetModel !== input.model || r.projectId !== task.projectId || r.taskId !== task.id || r.workspaceId !== workspace.id || r.workerId !== source.workerId || r.path !== workspace.path || record.sourceAgent !== source.agentId) return conflict();
        const pair = await readPair(actor, record);
        if (!pair) return denied();
        if (pair.source.taskId !== r.taskId || pair.source.workspaceId !== r.workspaceId || pair.source.workerId !== r.workerId || pair.source.agentId !== record.sourceAgent || pair.target.taskId !== r.taskId || pair.target.workspaceId !== r.workspaceId || pair.target.workerId !== r.workerId || pair.target.agentId !== r.targetAgent || pair.target.model !== r.targetModel) return conflict();
        return ok({ sessionId: pair.target.id });
      };
      const previous = await deps.store.byRequest(actor.user.id, source.id, input.requestId);
      if (previous) return replay(previous);
      if (!await deps.workspaceReady(task, workspace)) return conflict('工作空间尚未准备好');
      const descriptors = await deps.readyDescriptors(source.workerId);
      const matching = descriptors?.filter(d => offers(d, input.agentId, input.model)) ?? [];
      if (matching.length !== 1 || !deps.providerAllowed || !await deps.providerAllowed(actor, source.workerId, matching[0]!, input.model)) return conflict('目标运行时或模型不可用');
      const now = deps.now();
      const target = deriveSession({ task, agentId: asAgentId(input.agentId), model: input.model, now, workerId: source.workerId, workspaceId: source.workspaceId, createdBy: actor.user.id });
      if (!target.ok) return target;
      const result = await deps.store.reserve({ actorId: actor.user.id, sourceSessionId: source.id, sourceCursor: source.lastSeq, requestKey: input.requestId, semanticHash, target: target.value, projectId: task.projectId, taskId: task.id, workspaceId: workspace.id, workerId: source.workerId, path: workspace.path, targetAgent: input.agentId, targetModel: input.model, now });
      return result.kind === 'conflict' ? conflict() : result.kind === 'replay' ? replay(result.record) : ok({ sessionId: result.record.reservation.target.id });
    },
    async metadata(actor: Principal | null, targetId: string): Promise<Answer<{ handoff: null | { sourceSessionId: string; firstAccepted: boolean; firstCompleted?: true; startup: AgentHandoffRecord['startup']['state']; historyAvailable: boolean } }>> {
      if (!human(actor)) return denied();
      const target = await deps.session(targetId);
      if (!target || !await deps.sessionAllowed(actor, target, 'session.read')) return error('not_found', '会话不存在');
      const record = await deps.store.byTarget(target.id);
      if (!record) return ok({ handoff: null });
      const firstCompleted = await deps.firstCompleted?.(record) ?? false;
      if (!await readPair(actor, record)) return firstCompleted ? ok({ handoff: null }) : denied();
      let historyAvailable = false;
      if (!record.first) {
        try { historyAvailable = !!(await projection(record, ''))?.text; } catch { /* unavailable is not evidence */ }
      }
      return ok({ handoff: { sourceSessionId: record.reservation.sourceSessionId, firstAccepted: record.first !== null, ...(firstCompleted ? { firstCompleted: true as const } : {}), startup: deps.startupState?.(record) ?? record.startup.state, historyAvailable } });
    },
    async first(actor: Principal | null, targetId: string, input: { text: string; clientMessageId: string; withHistory: boolean }): Promise<Answer<PromptAck>> {
      if (!human(actor)) return denied();
      if (!small(targetId) || !small(input.clientMessageId) || typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 2 * 1024 * 1024 || typeof input.withHistory !== 'boolean') return invalid();
      const record = await deps.store.byTarget(targetId);
      const pair = record && await readPair(actor, record);
      if (!record || !pair) return denied();
      const r = record.reservation;
      if (!await deps.sessionAllowed(actor, pair.source, 'session.continue') || !await deps.sessionAllowed(actor, pair.target, 'session.prompt') || !await deps.workerUseAllowed(actor, r.workerId)) return denied();
      const task = pair.source.taskId && await deps.task(pair.source.taskId);
      if (!task || task.id !== r.taskId || task.projectId !== r.projectId || !await deps.taskActive(task) || !await deps.taskCreateAllowed(actor, task)) return denied();
      const semanticHash = hash([input.text, input.withHistory]);
      // Replays must not re-read mutable history or redispatch.
      let decoratedText = input.text;
      if (!record.first) {
        const workspace = await deps.workspace(r.workspaceId);
        if (!workspace || workspace.workerId !== r.workerId || !await deps.workspaceReady(task, workspace)) return conflict('工作空间尚未准备好');
        const descriptors = await deps.readyDescriptors(r.workerId);
        const matching = descriptors?.filter(d => offers(d, r.targetAgent, r.targetModel)) ?? [];
        if (matching.length !== 1 || !deps.providerAllowed || !await deps.providerAllowed(actor, r.workerId, matching[0]!, r.targetModel)) return conflict('目标运行时或模型不可用');
        try {
          if (input.withHistory) {
            const history = await projection(record, input.text);
            if (!history?.text) return conflict('历史不可用，请明确选择不带历史继续');
            decoratedText = history.deliveryText;
          } else {
            const windowTokens = await deps.targetWindow(r.workerId, r.targetAgent, r.targetModel);
            if (windowTokens !== null) buildAgentHandoffHistory({ sourceSessionId: r.sourceSessionId, cursor: r.sourceCursor, entries: [], deliveries: [], windowTokens, currentText: input.text });
            else if (Buffer.byteLength(input.text) > AGENT_HANDOFF_UNKNOWN_WINDOW_MAX_BYTES) return conflict('目标上下文窗口未知；不带历史的文本不能超过 64 KiB（不保证适合目标窗口）');
          }
        } catch (e) { return conflict(e instanceof RangeError ? e.message : '历史不可用，请明确选择不带历史继续'); }
      }
      const result = await deps.store.admitFirst({ targetSessionId: targetId, actorId: actor.user.id, requestKey: input.clientMessageId, semanticHash, text: input.text, decoratedText, clientMessageId: input.clientMessageId, deliveryId: newId(), now: deps.now() });
      if (result.kind === 'conflict' || !result.record.first) return conflict();
      if (result.kind === 'admitted') await deps.onAdmitted(result.record).catch(() => undefined);
      return ok({ seq: result.record.first.delivery.seq, deliveryId: result.record.first.delivery.id, state: 'queued', turn: 1 });
    }
  };
}
export type AgentHandoffService = ReturnType<typeof createAgentHandoffService>;
