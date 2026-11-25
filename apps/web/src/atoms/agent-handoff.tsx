import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, RequestFailed, type SessionDto } from '../shell/api.ts';
import { useAccount } from '../shell/account-context.ts';
import { DialogShell, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../shell/dialog-shell.tsx';
import { projectKeys } from '../shell/query-keys.ts';
import { resolveWorker, useWorkers } from '../shell/workers.tsx';
import { newClientMessageId } from './pending-prompt.ts';
import type { ModelItem } from './model-list.ts';

// A failed write must block submission: otherwise a reload can silently lose the
// only idempotency key. Values are scoped to the signed-in account and tab.
const storageKey = (accountId: string, ...parts: string[]) => `agent-handoff:${JSON.stringify([accountId, ...parts])}`;
function stored<T>(key: string): T | undefined {
  try { const value = sessionStorage.getItem(key); return value ? JSON.parse(value) as T : undefined; } catch { return undefined; }
}
function save(key: string, value: unknown): boolean {
  try { sessionStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
function remove(key: string) { try { sessionStorage.removeItem(key); } catch { /* already resolved */ } }

// Only the backend's documented status/code pairs are definitive refusals.
// Do not expose server messages, which may contain implementation details.
function refusal(failure: unknown): 'invalid' | 'forbidden' | 'not_found' | 'conflict' | null {
  if (!(failure instanceof RequestFailed)) return null;
  const code = failure.detail.code;
  if ((code === 'invalid' && failure.status === 400) || (code === 'forbidden' && failure.status === 403) || (code === 'not_found' && failure.status === 404) || (code === 'conflict' && failure.status === 409)) return code;
  return null;
}
const refusalAdvice = {
  invalid: '请检查提交的内容和选择。',
  forbidden: '请检查会话和机器的访问权限。',
  not_found: '请返回来源会话，检查会话是否仍然存在。',
  conflict: '请检查目标 Agent、模型和会话状态，或返回来源会话。'
} as const;

export function useHandoffCandidates(session: SessionDto, projectId: string): { items: ModelItem[]; note: string; choose: (value: string) => void; dialog: ReactNode } {
  const workers = useWorkers();
  const account = useAccount();
  const worker = resolveWorker(workers.list, session.workerId);
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<{ agentId: string; model: string; requestId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const candidates = (worker?.agentModels ?? []).filter((agent) => agent.agentId !== session.agentId);
  const items = candidates.flatMap((agent) => agent.models.map((model) => ({
    value: `handoff:${encodeURIComponent(agent.agentId)}:${encodeURIComponent(model)}`,
    label: `${agent.agentId} · ${model}`,
    group: `换 Agent · ${agent.agentId}`,
    keywords: [agent.agentId, model],
    description: worker?.state !== 'online' ? '当前机器离线' : agent.nativeHandoff !== true ? '此 Agent 暂不支持交接，或需要更新 Worker' : agent.readiness?.state !== 'ready' ? '这台机器尚未确认此 Agent 可用' : session.taskId === null || !session.workerId || !session.workspaceId || session.groupId || session.parentSessionId || session.kind === 'side' ? '仅支持有明确机器和单工作区的普通任务会话' : '新建会话，带上下文继续',
    disabled: worker?.state !== 'online' || agent.nativeHandoff !== true || agent.readiness?.state !== 'ready' || session.taskId === null || !session.workerId || !session.workspaceId || !!session.groupId || !!session.parentSessionId || session.kind === 'side'
  })));
  const choose = (value: string) => {
    const candidate = items.find((item) => item.value === value && !item.disabled);
    if (!candidate) return;
    const [, agent, model] = value.split(':');
    if (!agent || !model) return;
    const agentId = decodeURIComponent(agent), modelId = decodeURIComponent(model);
    const key = account && storageKey(account.id, 'reservation', session.id, agentId, modelId);
    const previous = key ? stored<{ requestId?: unknown }>(key) : undefined;
    const next = { agentId, model: modelId, requestId: typeof previous?.requestId === 'string' ? previous.requestId : newClientMessageId() };
    setTarget(next);
    setError(null);
  };
  const confirm = async () => {
    if (!target || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const key = account && storageKey(account.id, 'reservation', session.id, target.agentId, target.model);
      if (!key || !save(key, { requestId: target.requestId })) {
        setError('无法在此标签页保存请求编号，暂不能创建会话。请检查浏览器存储设置。');
        return;
      }
      const result = await api.createAgentHandoff(session.id, target);
      remove(key);
      await queryClient.invalidateQueries({ queryKey: projectKeys.canvas(projectId) }).catch(() => undefined);
      window.location.hash = `#/p/${encodeURIComponent(projectId)}/focus/${encodeURIComponent(result.sessionId)}`;
    } catch (failure) {
      const denied = refusal(failure);
      setError(denied ? `本次创建请求被拒绝。${refusalAdvice[denied]} 如果之前请求结果未知，仍需核对；不会自动重试，再次确认使用原请求编号。` : '未能确认是否创建成功。不会自动重试；可再次确认，同一次请求使用原请求编号。');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const dialog = target ? <DialogShell title="换 Agent，带上下文继续" onClose={() => { if (!busy) setTarget(null); }}>
    <div className="space-y-3 text-body text-secondary" data-testid="handoff-confirm">
      <p className="text-head text-primary">新建 {target.agentId} · {target.model} 会话？</p>
      <p>保留原会话和草稿，在同一台机器、同一工作区新建会话；不会中断原会话或自动发送。</p>
      <p>机器：{worker?.label ?? '未知'} · 工作区：{session.workspaceId ?? '未知'}</p>
      <p>首条消息可携带可确认出处的部分对话。旧附件、工具状态、审批、原生会话和选项不会迁移；不会增加访问权限。工作目录相同不代表文件隔离。</p>
      {error ? <p role="alert" className="text-rust">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2"><button className={SECONDARY_BUTTON} disabled={busy} onClick={() => setTarget(null)}>取消</button><button className={PRIMARY_BUTTON} disabled={busy} onClick={() => void confirm()}>{busy ? '正在确认…' : error ? '再次确认' : '确认新建会话'}</button></div>
    </div>
  </DialogShell> : null;
  const note = workers.loading ? '正在读取当前机器的 Agent 和模型…' : workers.failed ? '无法读取当前机器的 Agent 和模型' : !worker ? '无法确认当前会话所在机器' : !worker.agentModels ? '当前机器尚未提供 Agent 模型清单' : '换 Agent 会新建会话，需另行确认。';
  return { items, note, choose, dialog };
}

type FirstAttempt = { clientMessageId: string; withHistory: boolean; salt: string; digest: string | null };
async function digestText(text: string, withHistory: boolean, salt: string): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  try {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([salt, text, withHistory])));
    return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

/** 在读到交接记录之前绝不放行普通发送；首条消息只走专用端点。 */
export function HandoffGate({ session, projectId, draft, onDraftChange, children }: { session: SessionDto; projectId: string; draft: string; onDraftChange: (text: string) => void; children: ReactNode }) {
  const account = useAccount();
  const key = account ? storageKey(account.id, 'first', session.id) : null;
  const query = useQuery({ queryKey: ['agent-handoff', session.id], queryFn: () => api.agentHandoff(session.id), retry: false, refetchInterval: (q) => q.state.data?.handoff?.firstAccepted && !q.state.data.handoff.firstCompleted && ['pending', 'claimed', 'ready'].includes(q.state.data.handoff.startup) ? 3000 : false });
  const [withHistory, setWithHistory] = useState(true);
  const [withoutConfirmed, setWithoutConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<FirstAttempt | undefined>(() => key ? stored<FirstAttempt>(key) : undefined);
  const [localText, setLocalText] = useState<string | null>(null);
  const [acceptedLocally, setAcceptedLocally] = useState(false);
  const queryClient = useQueryClient();
  const lock = useRef(false);
  useEffect(() => {
    setAttempt(key ? stored<FirstAttempt>(key) : undefined);
    setLocalText(null);
    setAcceptedLocally(false);
    setError(null);
  }, [key]);
  useEffect(() => {
    if (query.data?.handoff?.firstAccepted && key) { remove(key); setAttempt(undefined); }
  }, [query.data?.handoff?.firstAccepted, key]);
  const link = (id: string) => `#/p/${encodeURIComponent(projectId)}/focus/${encodeURIComponent(id)}`;
  if (query.isLoading) return <p role="status" className="text-meta text-secondary">正在核对会话来源，暂不能发送…</p>;
  if (!query.data) return <div role="alert" className="text-meta text-rust">无法核对会话来源，暂不能发送。 <button className="text-link underline" onClick={() => void query.refetch()}>重新查看</button></div>;
  const handoff = query.data.handoff;
  if (!handoff) return <>{children}</>;
  const send = async () => {
    if (lock.current || busy || acceptedLocally || handoff.firstAccepted || ['failed', 'unknown'].includes(handoff.startup)) return;
    const effectiveHistory = attempt?.withHistory ?? (handoff.historyAvailable && withHistory);
    const text = localText ?? draft.trim();
    if (!text || (!attempt && !effectiveHistory && !withoutConfirmed)) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      let next = attempt;
      if (next) {
        if (!localText && (!next.digest || await digestText(text, next.withHistory, next.salt) !== next.digest)) {
          setError(next.digest ? '内容与原首条不一致，请重新输入原内容；不会自动发送。' : '此浏览器无法安全核对原文，刷新后无法重试。请返回来源会话并联系管理员核对结果。');
          return;
        }
      } else {
        const salt = newClientMessageId();
        next = { clientMessageId: newClientMessageId(), withHistory: effectiveHistory, salt, digest: await digestText(text, effectiveHistory, salt) };
      }
      if (!key || !save(key, next)) {
        setError('无法在此标签页保存消息编号，暂不能提交。请检查浏览器存储设置。');
        return;
      }
      setAttempt(next);
      setLocalText(text);
      const receipt = await api.firstAgentHandoff(session.id, { text, clientMessageId: next.clientMessageId, withHistory: next.withHistory });
      remove(key);
      setAttempt(undefined);
      setAcceptedLocally(true);
      if (draft.trim() === text) onDraftChange('');
      queryClient.setQueryData(['agent-handoff', session.id], { handoff: { ...handoff, firstAccepted: true } });
      void queryClient.invalidateQueries({ queryKey: projectKeys.canvas(projectId) }).catch(() => undefined);
      setError(receipt.state === 'queued' ? '首条已排队，不代表已送达。' : '首条已接收，不代表已送达。');
    } catch (failure) {
      const denied = refusal(failure);
      setError(denied ? `本次首条请求被拒绝。${refusalAdvice[denied]} 如果之前请求结果未知，仍需核对。内容和历史选择保持不变；不会自动重发，再次确认使用同一消息编号。` : '首条消息是否已接收尚未确认。不会自动重发；再次确认将使用同一消息编号。');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const blocked = handoff.startup === 'failed' || handoff.startup === 'unknown';
  return <div className="space-y-2" data-testid="handoff-gate">
    <div className="rounded-sm border border-hair bg-card px-3 py-2 text-meta text-secondary" role="status">
      <p>已创建交接会话 · <a className="text-link underline" href={link(handoff.sourceSessionId)}>返回来源会话</a></p>
      <p>{handoff.firstCompleted ? '首轮已结束。' : <>{handoff.firstAccepted || acceptedLocally ? '首条已接收；' : attempt ? '首条结果尚未确认；' : '尚未显示接收首条消息；'}{handoff.startup === 'ready' ? '上次核对显示运行时已就绪，不代表首轮已结束。' : handoff.startup === 'claimed' ? '上次核对显示正在启动运行时。' : handoff.startup === 'failed' ? '运行时启动失败，不会自动重试。' : handoff.startup === 'unknown' ? '启动结果未知，不会自动重试。' : '上次核对显示运行时尚未就绪。'}</>}</p>
      {(handoff.firstAccepted || acceptedLocally) && error ? <p>{error}</p> : null}
      {!handoff.firstCompleted && (handoff.firstAccepted || acceptedLocally) ? <p>{handoff.startup === 'ready' && handoff.firstAccepted ? '后续消息可排队；首轮尚未确认结束。' : '首条已排队或接收，暂不能发送。'} <button className="text-link underline" onClick={() => void query.refetch()}>重新查看</button></p> : null}
    </div>
    {handoff.firstCompleted || (handoff.firstAccepted && handoff.startup === 'ready') ? children : blocked || handoff.firstAccepted || acceptedLocally ? null : <div className="space-y-2 rounded-sm border border-strong p-3 text-meta text-secondary">
      <p>首条仅支持文本。可确认出处的历史可能截短或省略；旧附件、工具状态、审批和原生选项不迁移。</p>
      {attempt ? <p>原请求{attempt.withHistory ? '携带历史' : '不带历史'}，重试时不能更改。</p> : handoff.historyAvailable ? <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={withHistory} onChange={(e) => { setWithHistory(e.target.checked); setWithoutConfirmed(false); }} />携带可用历史</label> : <p>没有可用历史，可明确选择不带历史继续。</p>}
      {!attempt && (!handoff.historyAvailable || !withHistory) ? <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={withoutConfirmed} onChange={(e) => setWithoutConfirmed(e.target.checked)} />我确认不带历史继续</label> : null}
      {attempt && !localText ? <p>刷新后请重新输入完全相同的首条内容；历史选择保持不变。{!attempt.digest ? '此浏览器无法安全核对原文，不能重试。' : ''}</p> : null}
      <textarea aria-label="交接后的首条消息" className="min-h-20 w-full rounded-sm border border-hair bg-transparent p-2 text-body text-primary" value={draft} readOnly={!!attempt && !!localText} onChange={(e) => onDraftChange(e.target.value)} />
      {error ? <p role="alert" className="text-rust">{error}</p> : null}
      <button className={PRIMARY_BUTTON} disabled={busy || (!localText && !draft.trim()) || (!!attempt && !localText && !attempt.digest) || (!attempt && ((!handoff.historyAvailable || !withHistory) && !withoutConfirmed))} onClick={() => void send()}>{busy ? '正在提交…' : attempt ? '再次确认首条消息' : '提交首条消息'}</button>
    </div>}
  </div>;
}
