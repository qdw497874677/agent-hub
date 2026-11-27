import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { worktreePlansApi, type CanvasDto, type WorktreePlan, type WorkspaceViewDto } from '../../shell/api.ts';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';

type Member = { id: string; startRef: string; baseWorkspaceId: string };
const button = 'min-h-[44px] rounded-sm border border-hair px-3 text-sub text-secondary hover:border-strong disabled:opacity-50';
const member = (id: string): Member => ({ id, startRef: '', baseWorkspaceId: '' });
const stateText: Record<string, string> = { draft: '待确认', pending: '准备中', unknown: '待核对', 'ready-unused': '已创建，待使用', closed: '已结束', ready: '已完成', failed: '失败', skipped: '已跳过', running: '运行中' };

/** Explicit, task-scoped planning. Only execute changes the filesystem. */
export function WorktreeCreation({ canvas, taskId, workerId, localWorkerId, views, initialWorkspaceId, onUse, onClose }: {
  canvas: CanvasDto; taskId: string; workerId: string; views: readonly WorkspaceViewDto[];
  localWorkerId?: string;
  initialWorkspaceId?: string; onUse: (plan: WorktreePlan) => void; onClose: () => void;
}) {
  const projectId = canvas.project.id;
  const [source, setSource] = useState<'local' | 'project'>(initialWorkspaceId ? 'local' : 'project');
  const [members, setMembers] = useState<Member[]>(() => initialWorkspaceId ? [member(initialWorkspaceId)] : canvas.project.primaryRepoId ? [member(canvas.project.primaryRepoId)] : []);
  const [primaryId, setPrimaryId] = useState(initialWorkspaceId ?? canvas.project.primaryRepoId ?? '');
  const [plan, setPlan] = useState<WorktreePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const queryClient = useQueryClient();
  const recent = useQuery({ queryKey: ['worktree-plans', projectId, taskId], queryFn: () => worktreePlansApi.list(projectId, taskId), retry: false });
  const local = views.map((view) => view.workspace).filter((w) => (w.workerId ?? localWorkerId) === workerId && (w.state === 'ready' || w.state === 'kept') && (w.kind === 'long_lived' || w.ownerTaskId === taskId));
  const options = source === 'local' ? local.map((w) => ({ id: w.id, name: `${w.label || w.path} · ${w.path}`, disabled: w.isGit === false })) : canvas.project.repos.map((r) => ({ id: r.id, name: `${r.name} · ${r.url}`, disabled: false }));
  const switchSource = (next: 'local' | 'project') => {
    setSource(next); setPlan(null); setError('');
    const id = next === 'local' ? initialWorkspaceId ?? '' : canvas.project.primaryRepoId ?? '';
    setMembers(id ? [member(id)] : []); setPrimaryId(id);
  };
  const update = (index: number, patch: Partial<Member>) => setMembers((items) => items.map((item, i) => i === index ? { ...item, ...patch } : item));
  const remove = (id: string) => { setMembers((items) => items.filter((item) => item.id !== id)); if (primaryId === id) setPrimaryId(''); };
  const refresh = async (id: string) => {
    setBusy(true); setError('');
    try { setPlan(await worktreePlansApi.get(projectId, taskId, id)); }
    catch { setError('状态未能确认，请检查网络后再次核对；不要新建替代计划。'); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (plan?.state !== 'pending') return;
    const timer = window.setTimeout(() => { void refresh(plan.id); }, 3000);
    return () => window.clearTimeout(timer);
  }, [plan]);
  const preview = async () => {
    setBusy(true); setError('');
    try {
      const result = await worktreePlansApi.preview(projectId, taskId, { workerId, source, members: members.map((m) => ({ id: m.id, ...(m.startRef.trim() ? { startRef: m.startRef.trim() } : {}), ...(source === 'project' && m.baseWorkspaceId ? { baseWorkspaceId: m.baseWorkspaceId } : {}) })), primaryId: source === 'project' && members.length > 1 ? canvas.project.primaryRepoId! : primaryId || members[0]?.id });
      setPlan(result); void recent.refetch();
    } catch (e) { setError(e instanceof Error ? e.message : '预览失败，请检查后重试'); void recent.refetch(); }
    finally { setBusy(false); }
  };
  const execute = async () => {
    if (!plan || (plan.state !== 'draft' && plan.state !== 'unknown')) return;
    setBusy(true); setError('');
    try { setPlan(await worktreePlansApi.execute(projectId, taskId, plan.id, plan.revision)); void recent.refetch(); void queryClient.invalidateQueries({ queryKey: ['workspaces', projectId] }); }
    catch { setError('执行结果未确认。请先核对这份计划的状态，不要新建或重复提交。'); }
    finally { setBusy(false); }
  };
  const validPrimary = source === 'project' && members.length > 1 ? !!canvas.project.primaryRepoId && members.some((m) => m.id === canvas.project.primaryRepoId) : members.some((m) => m.id === primaryId) || members.length === 1;
  const invalidLocal = source === 'local' && members.some((m) => !local.some((w) => w.id === m.id && w.isGit !== false));
  const clones = plan?.members.filter((m) => m.baseAction === 'clone').length ?? 0;
  const retryable = plan?.state === 'unknown';
  return <section data-testid="worktree-creation" aria-label="创建 Worktree" className="my-3 space-y-3 rounded-md border border-strong p-3">
    <div className="flex items-center justify-between gap-2"><div><h3 className="text-body text-primary">创建 Worktree</h3><p className="text-meta text-tertiary">属于当前任务；不会复制未提交的改动，也不是安全隔离。</p></div><button type="button" className={button} onClick={onClose}>关闭</button></div>
    {!plan ? <>
      <fieldset className="space-y-1"><legend className="text-meta text-secondary">来源</legend><label className="flex min-h-[44px] items-center gap-2"><input type="radio" name="worktree-source" checked={source === 'project'} onChange={() => switchSource('project')} />按项目仓库</label><label className="flex min-h-[44px] items-center gap-2"><input type="radio" name="worktree-source" checked={source === 'local'} onChange={() => switchSource('local')} />从已有工作目录</label></fieldset>
      <p className="text-meta text-tertiary">{source === 'local' ? '从所选目录的实际本地仓库创建，不自动克隆或 fetch。' : '复用通过核验的仓库目录。若机器上没有，请先准备并登记仓库目录。'}</p>
      {initialWorkspaceId && source === 'local' && invalidLocal ? <p role="status" className="text-meta text-rust">当前目录不是可用的 Git 目录，请主动更换来源。</p> : null}
      {options.length === 0 ? <p className="text-meta text-tertiary">{source === 'local' ? '这台机器没有可选目录，请先登记目录。' : '项目还没有登记仓库。'}</p> : null}
      <label className="block text-meta text-secondary">添加{source === 'local' ? '工作目录' : '仓库'}<select data-testid="worktree-add-member" className={`mt-1 min-h-[44px] ${INPUT}`} value="" disabled={members.length >= 8} onChange={(e) => { if (e.target.value) { setMembers((items) => [...items, member(e.target.value)]); if (!primaryId) setPrimaryId(e.target.value); } }}><option value="">选择…</option>{options.filter((o) => !members.some((m) => m.id === o.id)).map((o) => <option key={o.id} value={o.id} disabled={o.disabled}>{o.name}{o.disabled ? ' · 非 Git' : ''}</option>)}</select></label>
      {members.map((m, index) => <div key={m.id} data-testid="worktree-member" className="space-y-2 rounded-sm border border-hair p-3"><div className="flex items-start justify-between gap-2"><p className="min-w-0 break-all text-sub text-primary">{options.find((o) => o.id === m.id)?.name ?? `不可用的目录 · ${m.id}`}</p><button type="button" className={button} onClick={() => remove(m.id)} aria-label={`移除 ${options.find((o) => o.id === m.id)?.name ?? m.id}`}>移除</button></div>
        <label className="block text-meta text-secondary">起点（可选；留空使用默认起点）<input className={`mt-1 min-h-[44px] ${INPUT}`} value={m.startRef} onChange={(e) => update(index, { startRef: e.target.value })} /></label>
        {source === 'project' ? <label className="block text-meta text-secondary">指定底座（可选）<select className={`mt-1 min-h-[44px] ${INPUT}`} value={m.baseWorkspaceId} onChange={(e) => update(index, { baseWorkspaceId: e.target.value })}><option value="">由系统核验；有多个匹配时需选择</option>{local.filter((w) => w.isGit !== false).map((w) => <option key={w.id} value={w.id}>{w.path} · {w.id}</option>)}</select></label> : null}
        {members.length > 1 && source === 'local' ? <label className="flex min-h-[44px] items-center gap-2 text-sub"><input type="radio" name="worktree-primary" checked={primaryId === m.id} onChange={() => setPrimaryId(m.id)} />主目录 · 会话起点</label> : null}
        {source === 'project' && members.length > 1 && canvas.project.primaryRepoId === m.id ? <p className="text-meta text-secondary">项目主仓 · 会话起点</p> : null}
      </div>)}
      {source === 'project' && members.length > 1 && !validPrimary ? <p className="text-meta text-rust">多仓需先设置项目主仓，并将主仓加入本次选择。</p> : null}
      <p className="text-meta text-tertiary">此处创建 Worktree 不会运行项目准备命令。</p>
      <button type="button" data-testid="worktree-preview" className={PRIMARY_BUTTON + ' min-h-[44px]'} disabled={busy || !members.length || !validPrimary || invalidLocal} onClick={() => void preview()}>预览创建计划</button>
      {recent.isError ? <p className="text-meta text-rust">未能读取近期计划，请检查网络后重试。</p> : null}
      {(recent.data?.plans ?? []).filter((p) => p.state !== 'closed' && p.workerId === workerId).length ? <details className="rounded-sm border border-hair p-2"><summary className="min-h-[44px] cursor-pointer text-sub">查看这台机器的近期计划和进度</summary>{recent.data!.plans.filter((p) => p.state !== 'closed' && p.workerId === workerId).map((p) => <button key={p.id} type="button" data-testid="worktree-recent-plan" className="block min-h-[44px] w-full break-all border-t border-hair text-left text-meta" onClick={() => void refresh(p.id)}>{p.id} · {stateText[p.state]} · {p.members.map((m) => m.name).join('、')}</button>)}</details> : null}
    </> : <div data-testid="worktree-plan" className="space-y-3"><p role="status" className="text-sub text-primary">{plan.state === 'draft' ? '确认创建计划' : `计划状态：${stateText[plan.state]}`} · {plan.workerId}{plan.state === 'failed' ? ' · 已确认没有产生文件系统变更，可返回修改选择。' : ''}</p>
      {plan.members.map((m) => <div key={m.id} data-testid="worktree-plan-member" className="space-y-1 rounded-sm border border-hair p-3 text-meta"><p className="text-sub text-primary">{m.name}{m.id === plan.primaryId ? ' · 主目录 · 会话起点' : ''}</p><p className="break-all">来源：{m.sourcePath ?? '尚未克隆'}{plan.source === 'project' ? ` · ${m.baseAction === 'clone' ? '需克隆' : '复用底座'}` : ''}</p><p className="break-all">起点：{m.startRef || '默认起点'} · {m.oid}</p><p className="break-all">新分支：{m.branch}</p><p className="break-all">目标：{m.targetPath}</p><p>状态：{stateText[m.state]}{m.problem ? ` · ${m.problem}` : ''}</p></div>)}
      <p className="break-all text-meta text-secondary">准备命令：{plan.setupCommand || '不运行'} · {stateText[plan.setupState]}</p>{plan.problem ? <p role="status" className="text-meta text-rust">{plan.problem}</p> : null}
      <p className="text-meta text-tertiary">确认后离开页面不会撤销已创建的底座、目录或分支；可在近期计划中核对进度。</p>
      <div className="flex flex-wrap gap-2">{plan.state === 'draft' || plan.state === 'failed' ? <button type="button" className={SECONDARY_BUTTON + ' min-h-[44px]'} disabled={busy} onClick={() => { setPlan(null); setError(''); }}>修改选择</button> : null}{plan.state === 'draft' ? <button type="button" data-testid="worktree-confirm" className={PRIMARY_BUTTON + ' min-h-[44px]'} disabled={busy || !!error} onClick={() => void execute()}>{busy ? '提交中…' : `确认创建 Worktree${clones ? ` · 将克隆 ${clones} 个仓库` : ''}`}</button> : null}
      <button type="button" data-testid="worktree-refresh" className={button} disabled={busy} onClick={() => void refresh(plan.id)}>核对状态</button>
      {retryable && !error ? <button type="button" data-testid="worktree-reconcile" className={button} disabled={busy} onClick={() => { if (window.confirm('确认核对并重试这份计划中可安全继续的步骤？已完成的结果将保留。')) void execute(); }}>确认核对并继续</button> : null}
      {plan.state === 'ready-unused' && (plan.workspaceId || plan.groupId) ? <button type="button" data-testid="worktree-use" className={PRIMARY_BUTTON + ' min-h-[44px]'} onClick={() => onUse(plan)}>使用此结果开始会话</button> : null}</div>
    </div>}
    {error ? <p role="alert" className="break-words text-meta text-rust">{error}</p> : null}
  </section>;
}
