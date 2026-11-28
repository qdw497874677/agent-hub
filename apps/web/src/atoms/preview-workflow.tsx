import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { previewWorkflowApi, type PreviewDiagnostic, type PreviewWorkflowTarget } from '../shell/api.ts';
import { DialogShell, SMALL_BUTTON } from '../shell/dialog-shell.tsx';
import { sessionKeys } from '../shell/query-keys.ts';
import { useAccount } from '../shell/account-context.ts';
import { diagnosticTargetIdentity, diagnosticText, previewFeedbackPath, serviceWorkflowTargets, transportLimited, workflowTargetUrl } from './preview-workflow-model.ts';

const PRIMARY = 'inline-flex min-h-[44px] items-center justify-center rounded-sm bg-action px-3 text-meta text-action-fg hover:bg-action/90 md:min-h-8';
const SECONDARY = `${SMALL_BUTTON} inline-flex min-h-[44px] items-center justify-center md:min-h-8`;
// Shared by the session and service entry points, including after a component remount.
const registrationAttempts = new Set<string>();
function wasAttempted(key: string): boolean {
  if (registrationAttempts.has(key)) return true;
  try { return sessionStorage.getItem(`preview-registration:${key}`) === '1'; } catch { return false; }
}
function rememberAttempt(key: string) {
  registrationAttempts.add(key);
  try { sessionStorage.setItem(`preview-registration:${key}`, '1'); } catch { /* in-memory protection still applies */ }
}

/** 所有入口共用服务端的会话投影；服务卡片只筛选，不按端口猜链接。 */
export function PreviewWorkflowAction({ sessionId, service, onManage, onFeedback, compact = false, conversationRow = false }: {
  sessionId: string;
  service?: { port: number; workerId: string };
  onManage?: () => void;
  onFeedback?: (text: string) => void;
  compact?: boolean;
  conversationRow?: boolean;
}) {
  const client = useQueryClient();
  const account = useAccount();
  const key = sessionKeys.previewWorkflow(sessionId);
  const workflow = useQuery({ queryKey: key, queryFn: () => previewWorkflowApi.get(sessionId), retry: false, staleTime: 10_000 });
  const [open, setOpen] = useState(false);
  const [registering, setRegistering] = useState<number | null>(null);
  // A lost response is ambiguous: never retry a registration automatically or on another click.
  const [attempted, setAttempted] = useState<ReadonlySet<string>>(() => new Set(registrationAttempts));
  const [notice, setNotice] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Record<string, PreviewDiagnostic>>({});
  const [checking, setChecking] = useState<string | null>(null);
  const [feedbackTarget, setFeedbackTarget] = useState<PreviewWorkflowTarget | null>(null);
  const [feedbackPath, setFeedbackPath] = useState('/');
  const [feedbackDescription, setFeedbackDescription] = useState('');
  const generation = useRef(0);
  const sessionGeneration = useRef(0);
  const targetTokens = useRef(new Map<string, object>());
  const targets = service ? serviceWorkflowTargets(workflow.data?.targets ?? [], service.port, service.workerId) : workflow.data?.targets ?? [];
  const identityList = workflow.data?.available ? targets.filter((target) => target.linkId !== null).map(diagnosticTargetIdentity).sort() : [];
  const identitySnapshot = JSON.stringify(identityList);
  // Reconcile at commit, before a response or a click can observe a new mapping.
  // Retaining a token requires uninterrupted membership, so A → B → A cannot revive an old response.
  useLayoutEffect(() => {
    const identities = new Set<string>(JSON.parse(identitySnapshot) as string[]);
    const previous = targetTokens.current;
    const next = new Map<string, object>();
    for (const identity of identities) next.set(identity, previous.get(identity) ?? {});
    targetTokens.current = next;
    setDiagnostics((current) => {
      const entries = Object.entries(current).filter(([identity]) => identities.has(identity));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
    setChecking((current) => current !== null && !identities.has(current) ? null : current);
  }, [identitySnapshot]);
  useEffect(() => {
    const reset = () => { generation.current += 1; setDiagnostics({}); setChecking(null); };
    window.addEventListener('online', reset);
    window.addEventListener('offline', reset);
    return () => { window.removeEventListener('online', reset); window.removeEventListener('offline', reset); };
  }, []);
  useLayoutEffect(() => {
    generation.current += 1;
    sessionGeneration.current += 1;
    targetTokens.current = new Map([...targetTokens.current.keys()].map((identity) => [identity, {}]));
    setDiagnostics({});
    setOpen(false); setNotice(null); setChecking(null); setRegistering(null); setFeedbackTarget(null);
    return () => { generation.current += 1; sessionGeneration.current += 1; };
  }, [sessionId, account?.id]);
  const directUrl = workflow.data?.available && targets.length === 1 ? workflowTargetUrl(targets[0]!) : null;
  const directLimited = !!directUrl && transportLimited(window.location.protocol, directUrl);

  const refresh = async () => {
    setNotice(null);
    const currentGeneration = generation.current;
    const result = await workflow.refetch();
    if (generation.current === currentGeneration && result.isError) setNotice('暂时无法检查预览，请稍后再检查。');
  };

  const diagnose = async (target: PreviewWorkflowTarget) => {
    if (!target.linkId) return;
    const identity = diagnosticTargetIdentity(target);
    const token = targetTokens.current.get(identity);
    if (!token) return;
    const currentGeneration = generation.current;
    const current = () => generation.current === currentGeneration && targetTokens.current.get(identity) === token;
    setChecking(identity);
    try {
      const result = await previewWorkflowApi.diagnostic(sessionId, target.linkId);
      if (current()) setDiagnostics((previous) => ({ ...previous, [identity]: result }));
    } catch {
      if (current()) setNotice('检查未完成，页面响应仍未确认。');
    } finally {
      if (current()) setChecking((previous) => previous === identity ? null : previous);
    }
  };

  const register = async (target: PreviewWorkflowTarget) => {
    const attempt = JSON.stringify([account?.id ?? null, sessionId, target.workerId, target.port]);
    if (registering !== null || wasAttempted(attempt)) return;
    rememberAttempt(attempt);
    setAttempted(new Set(registrationAttempts));
    setRegistering(target.port);
    setNotice(null);
    const currentGeneration = sessionGeneration.current;
    try {
      await previewWorkflowApi.register(sessionId, target.port);
      if (sessionGeneration.current === currentGeneration) setNotice('登记请求已完成，请在下方确认入口后打开。');
    } catch {
      if (sessionGeneration.current === currentGeneration) setNotice('登记结果尚未确认。请重新检查已有结果，不要重复添加端口。');
    } finally {
      if (sessionGeneration.current === currentGeneration) setRegistering(null);
      // Refetch only: never automatically open a tab after an asynchronous request.
      await client.invalidateQueries({ queryKey: key });
    }
  };

  const triggerClass = compact ? SECONDARY : PRIMARY;
  const close = () => { generation.current += 1; setDiagnostics({}); setChecking(null); setFeedbackTarget(null); setOpen(false); };
  const feedbackKey = (target: PreviewWorkflowTarget) => `preview-feedback-path:${JSON.stringify([account?.id, sessionId, target.linkId])}`;
  const beginFeedback = (target: PreviewWorkflowTarget) => {
    let path = '/';
    try { path = previewFeedbackPath(localStorage.getItem(feedbackKey(target)) ?? '/') ?? '/'; } catch { /* storage is optional */ }
    setFeedbackTarget(target); setFeedbackPath(path); setFeedbackDescription('');
  };
  const submitFeedback = () => {
    if (!feedbackTarget || !onFeedback) return;
    const path = previewFeedbackPath(feedbackPath);
    if (path === null) return;
    if (account?.id && feedbackTarget.linkId) {
      try { localStorage.setItem(feedbackKey(feedbackTarget), path); } catch { /* storage is optional */ }
    }
    const title = feedbackTarget.label || `端口 ${feedbackTarget.port}`;
    onFeedback(`预览：${title}\n页面路径：${path}${feedbackDescription.trim() ? `\n复现说明：${feedbackDescription.trim()}` : ''}`);
    close();
  };
  if (!workflow.data?.available) return null;
  const content = <>
    {directUrl && !directLimited ? <a data-testid={service ? 'service-open-preview' : 'workflow-open-preview'} className={triggerClass} href={directUrl} target="_blank" rel="noopener noreferrer">打开预览</a> :
      <button type="button" data-testid={service ? 'service-open-preview' : 'workflow-open-preview'} className={triggerClass} onClick={() => { setOpen(true); const target = targets[0]; if (workflow.data?.available && targets.length === 1 && target?.mapping === 'pending' && target.linkId === null) void register(target); }}>打开预览</button>}
    {directUrl ? <button type="button" className={SECONDARY} onClick={() => setOpen(true)} aria-label="更多预览选项">更多</button> : null}
    {open ? <DialogShell title="打开预览" testId="preview-workflow-dialog" onClose={close}>
      <div className="space-y-3 text-meta">
        {workflow.isPending ? <p role="status" className="text-tertiary">正在检查预览目标…</p> : null}
        {workflow.isError ? <p role="alert" className="text-rust">暂时无法检查预览目标，请重试{onManage ? '或打开预览管理' : '或前往会话的预览管理'}。</p> : null}
        {workflow.data && !workflow.data.available ? <p className="text-secondary">预览入口暂不可用，请检查预览配置或打开预览管理。</p> : null}
        {workflow.data?.available && targets.length === 0 ? <p className="text-secondary">没有找到可确认的预览目标。可以重新检查，或前往会话的预览管理手动添加端口。</p> : null}
        {targets.length > 1 ? <p className="text-secondary">选择要打开的预览：</p> : null}
        {targets.map((target) => {
          const url = workflow.data?.available ? workflowTargetUrl(target) : null;
          const identity = diagnosticTargetIdentity(target);
          const diagnostic = diagnostics[identity];
          const attempt = JSON.stringify([account?.id ?? null, sessionId, target.workerId, target.port]);
          const submitted = attempted.has(attempt) || wasAttempted(attempt);
          return <div key={`${target.workerId}:${target.port}`} data-testid="preview-workflow-target" className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-hair px-3 py-2">
            <div className="min-w-0">
              <p className="break-words text-primary">{target.label || `端口 ${target.port}`} <span className="font-mono text-tertiary">:{target.port}</span></p>
              <p className="break-all text-tertiary">机器 {target.workerId}</p>
              <p className="text-tertiary">映射：{target.mapping === 'ready' ? (url ? '已就绪' : '入口地址未就绪') : target.mapping === 'pending' ? (target.linkId ? '入口准备中' : '等待登记') : '不可用'}</p>
              <p className="text-tertiary">检查：{diagnostic ? `${diagnosticText(diagnostic)} · ${new Date(diagnostic.checkedAt).toLocaleTimeString()}` : '未确认'}{diagnostic?.state === 'response' ? '（Hub 侧检查，不代表你的设备可访问）' : ''}</p>
              {url && transportLimited(window.location.protocol, url) ? <p data-testid="preview-transport-warning" className="mt-1 text-rust">当前 Hub 使用 HTTPS，但此预览使用 HTTP。安全登录 Cookie 无法发送到此入口，私有预览可能无法通过登录验证；请联系管理员配置安全访问方式。</p> : null}
            </div>
            {url ? <a className={PRIMARY} href={url} target="_blank" rel="noopener noreferrer">打开预览</a> : target.mapping === 'pending' && target.linkId === null && workflow.data?.available ?
              <button type="button" className={SECONDARY} disabled={registering !== null || submitted} onClick={() => void register(target)}>{registering === target.port ? '登记中…' : submitted ? '等待确认' : '登记预览'}</button> : null}
            {target.linkId ? <button type="button" className={SECONDARY} disabled={checking !== null} onClick={() => void diagnose(target)}>{checking === identity ? '检查中…' : '检查状态'}</button> : null}
            {target.linkId && onFeedback ? <button type="button" data-testid="preview-feedback-open" className={SECONDARY} onClick={() => beginFeedback(target)}>反馈到对话</button> : null}
          </div>;
        })}
        {feedbackTarget ? <div data-testid="preview-feedback-form" className="space-y-2 rounded-sm border border-hair bg-card p-3">
          <p className="text-primary">反馈：{feedbackTarget.label || `端口 ${feedbackTarget.port}`}</p>
          <label className="block text-secondary">页面路径（请从预览页填写；查询参数和片段不会保留）<input data-testid="preview-feedback-path" className="mt-1 min-h-[44px] w-full rounded-sm border border-hair bg-card px-2 text-primary" value={feedbackPath} onChange={(event) => setFeedbackPath(event.target.value)} placeholder="/" /></label>
          {previewFeedbackPath(feedbackPath) === null ? <p role="alert" className="text-rust">请填写以 / 开头的页面路径，不要填写网址。</p> : null}
          <label className="block text-secondary">复现说明<textarea data-testid="preview-feedback-description" className="mt-1 min-h-[80px] w-full rounded-sm border border-hair bg-card p-2 text-primary" value={feedbackDescription} onChange={(event) => setFeedbackDescription(event.target.value)} /></label>
          <p className="text-tertiary">只会追加到当前会话草稿，不会自动发送。</p>
          <div className="flex flex-wrap gap-2"><button data-testid="preview-feedback-submit" type="button" className={PRIMARY} disabled={previewFeedbackPath(feedbackPath) === null} onClick={submitFeedback}>添加到对话草稿</button><button type="button" className={SECONDARY} onClick={() => setFeedbackTarget(null)}>取消</button></div>
        </div> : null}
        {notice ? <p role="status" className="text-secondary">{notice}</p> : null}
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" className={SECONDARY} disabled={workflow.isFetching} onClick={() => void refresh()}>{workflow.isFetching ? '检查中…' : '重新检查'}</button>
          {onManage ? <button type="button" className={SECONDARY} onClick={() => { close(); onManage(); }}>更多：预览管理</button> : null}
        </div>
      </div>
    </DialogShell> : null}
  </>;
  return conversationRow ? <div className="flex shrink-0 items-center gap-2 border-b border-hair px-3 py-1.5">{content}</div> : content;
}
