import type { AgentHandoffRecord, AgentHandoffStartup, AgentHandoffStore, NodeGateway, RuntimeOption } from '@agent-hub/domain';
import { startCommand } from '@agent-hub/domain';

/** The gateway's receipt identity; isCurrent must be checked again before side effects. */
export interface HandoffStartMetadata {
  readonly attemptId: string;
  readonly connectionId: string;
  readonly isCurrent: () => boolean;
  /** Present only on an accepted keyed ready result; options are schema-validated. */
  readonly ready?: HandoffStartObserved;
}
export interface HandoffStartObserved {
  readonly agentSessionRef?: string;
  readonly options?: readonly RuntimeOption[];
}
interface ActiveStart {
  readonly input: AgentHandoffStartup;
  readonly timer: ReturnType<typeof setTimeout>;
}
const MAX_REF_BYTES = 512;
const MAX_OPTIONS_BYTES = 256 * 1024;

// Keep aligned with the SQLite ready-CAS validation; never synthesize a ref.
function usableNativeRef(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.trim().length > 0 && Buffer.byteLength(ref) <= MAX_REF_BYTES
    && ref.trim().toLowerCase() !== 'pending' && !/[\u0000-\u001f\u007f-\u009f]/.test(ref);
}

function observedReady(ready: HandoffStartObserved, ref: string): HandoffStartObserved {
  let options: readonly RuntimeOption[] | undefined;
  if (Array.isArray(ready.options)) {
    try {
      const json = JSON.stringify(ready.options);
      if (Buffer.byteLength(json) <= MAX_OPTIONS_BYTES) options = JSON.parse(json) as RuntimeOption[];
    } catch { /* Unserializable or oversized proof is omitted. */ }
  }
  return {
    agentSessionRef: ref,
    ...(options !== undefined ? { options } : {})
  };
}

export interface AgentHandoffStartupDeps {
  readonly store: Pick<AgentHandoffStore, 'byTarget' | 'claimStartup' | 'settleStartup'>;
  readonly gateway: Pick<NodeGateway, 'dispatch' | 'sessionStartConnection' | 'sessionStartReadiness'>;
  now(): number;
  newAttemptId(): string;
  /** Add hosting and wake; check isCurrent before each side effect. */
  onReady(workerId: string, sessionId: string, isCurrent: () => boolean): void | Promise<void>;
  readonly timeoutMs?: number;
}

/** Only invoke start for a newly admitted first message; never reconstruct starts on reconnect. */
export function createAgentHandoffStartup(deps: AgentHandoffStartupDeps) {
  const active = new Map<string, ActiveStart>();

  function matching(workerId: string, sessionId: string, metadata?: HandoffStartMetadata): ActiveStart | undefined {
    const entry = active.get(sessionId);
    if (!entry || !metadata || entry.input.workerId !== workerId || entry.input.attemptId !== metadata.attemptId || entry.input.connectionId !== metadata.connectionId) return undefined;
    try {
      return metadata.isCurrent() && deps.gateway.sessionStartConnection?.(workerId) === entry.input.connectionId && metadata.isCurrent() ? entry : undefined;
    } catch { return undefined; }
  }

  function clear(input: AgentHandoffStartup) {
    const entry = active.get(input.targetSessionId);
    if (entry?.input.attemptId === input.attemptId) {
      clearTimeout(entry.timer);
      active.delete(input.targetSessionId);
    }
  }
  function isReady(sessionId: AgentHandoffRecord['reservation']['target']['id'], workerId: string | null, connectionId: string | null, attemptId: string | null): boolean {
    if (!workerId || !connectionId || !attemptId) return false;
    try {
      if (deps.gateway.sessionStartConnection?.(workerId) !== connectionId) return false;
      const ready = deps.gateway.sessionStartReadiness?.(sessionId, workerId);
      return ready?.state === 'ready' && ready.startAttemptId === attemptId && deps.gateway.sessionStartConnection?.(workerId) === connectionId;
    } catch {
      return false;
    }
  }
  /** Display-only projection: unknown is not permission to retry or adopt an attempt. */
  function metadataState(record: AgentHandoffRecord): AgentHandoffRecord['startup']['state'] {
    const { state, workerId, connectionId, attemptId } = record.startup;
    if (state === 'pending') return record.first ? 'unknown' : 'pending';
    if (state === 'ready') return isReady(record.reservation.target.id, workerId, connectionId, attemptId) ? 'ready' : 'unknown';
    if (state !== 'claimed') return state;
    const input = active.get(record.reservation.target.id)?.input;
    if (!input || !record.first || input.deliveryId !== record.first.delivery.id || input.workerId !== workerId || input.connectionId !== connectionId || input.attemptId !== attemptId) return 'unknown';
    try {
      return deps.gateway.sessionStartConnection?.(input.workerId) === input.connectionId ? 'claimed' : 'unknown';
    } catch {
      return 'unknown';
    }
  }
  async function unknown(input: AgentHandoffStartup) {
    // Stop accepting late evidence once the deadline or a proofless failure wins locally.
    clear(input);
    try {
      const result = await deps.store.settleStartup({ ...input, now: deps.now(), state: 'unknown' });
      if (result.kind === 'settled' || result.record?.startup.state !== 'claimed') clear(input);
    } catch {
      // A persistence failure is not evidence of an outcome or permission to retry.
    }
  }
  return {
    metadataState,
    async start(record: AgentHandoffRecord): Promise<void> {
      if (!record.first || record.startup.state !== 'pending') return;
      const { target, workerId, path } = record.reservation;
      const connectionId = deps.gateway.sessionStartConnection?.(workerId);
      if (!connectionId) return;
      const input: AgentHandoffStartup = { targetSessionId: target.id, deliveryId: record.first.delivery.id, attemptId: deps.newAttemptId(), workerId, connectionId, now: deps.now() };
      const claim = await deps.store.claimStartup(input);
      if (claim.kind !== 'claimed') return;
      const timer = setTimeout(() => { void unknown(input); }, deps.timeoutMs ?? 30_000);
      timer.unref();
      active.set(target.id, { input, timer });
      try {
        const command = { ...startCommand({ ...target, workerId }, path, null, {}), startAttemptId: input.attemptId, expectedStartConnectionId: connectionId };
        const sent = await deps.gateway.dispatch(command);
        if (!sent.ok) await unknown(input);
      } catch {
        // Dispatch failures are proofless, including failures during preparation.
        await unknown(input);
      }
    },
    async changed(workerId: string, sessionId: string, metadata?: HandoffStartMetadata): Promise<boolean> {
      const record = await deps.store.byTarget(sessionId);
      if (!record) return false;
      if (record.startup.state === 'ready') {
        const { workerId: owner, connectionId, attemptId } = record.startup;
        if (!metadata?.ready || !usableNativeRef(metadata.ready.agentSessionRef) || workerId !== owner || metadata.connectionId !== connectionId || metadata.attemptId !== attemptId) return true;
        try { return !(metadata.isCurrent() && isReady(record.reservation.target.id, owner, connectionId, attemptId) && metadata.isCurrent()); }
        catch { return true; }
      }
      const entry = active.get(sessionId);
      if (!entry || entry.input.workerId !== workerId || record.startup.state !== 'claimed') return true;
      const input = entry.input;
      if (deps.gateway.sessionStartConnection?.(workerId) !== input.connectionId) {
        await unknown(input);
        return true;
      }
      // Readiness's failed shape is unkeyed; only gateway callback metadata proves
      // this is the same live generation. A gateway timeout is not failure proof.
      if (matching(workerId, sessionId, metadata)) {
        const readiness = deps.gateway.sessionStartReadiness?.(record.reservation.target.id, workerId);
        if (readiness?.state === 'failed' && readiness.reason !== 'timed_out' && matching(workerId, sessionId, metadata)) {
          clear(input);
          await deps.store.settleStartup({ ...input, now: deps.now(), state: 'failed' });
          return true;
        }
      }
      if (!metadata?.ready || !matching(workerId, sessionId, metadata) || !isReady(record.reservation.target.id, input.workerId, input.connectionId, input.attemptId) || !matching(workerId, sessionId, metadata)) return true;
      const ref = metadata.ready.agentSessionRef;
      if (!usableNativeRef(ref)) {
        clear(input);
        await deps.store.settleStartup({ ...input, now: deps.now(), state: 'failed' });
        return true;
      }
      const observed = observedReady(metadata.ready, ref);
      const result = await deps.store.settleStartup({ ...input, now: deps.now(), state: 'ready', observed });
      if (result.kind === 'settled') {
        clear(input);
        const isCurrent = () => {
          try { return metadata.isCurrent() && isReady(record.reservation.target.id, input.workerId, input.connectionId, input.attemptId) && metadata.isCurrent(); }
          catch { return false; }
        };
        if (isCurrent()) await deps.onReady(workerId, sessionId, isCurrent);
      } else if (result.record?.startup.state !== 'claimed') clear(input);
      return true;
    }
  };
}
