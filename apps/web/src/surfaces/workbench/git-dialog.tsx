import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { gitApi, type GitRunDto, type PullRequestDto } from '../../shell/api.ts';
import { DialogShell, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';

/**
 * 提交 / 推送 / 开 PR（ADR 0027 阶段 2）：说明由项目的提炼模型起草（D4，失败回落模板），人可以改；
 * PR 走团队 token → 机器上的 gh → 只推送 + 给链接（D3）。
 */
const STATUS: Record<string, string> = { untracked: '新', added: '新', modified: '改', deleted: '删', renamed: '名' };

export function GitDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const queries = useQueryClient();
  const state = useQuery({ queryKey: ['git', sessionId, 'state'], queryFn: () => gitApi.state(sessionId) });
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [source, setSource] = useState<'model' | 'template' | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GitRunDto | null>(null);

  async function draft() {
    setDrafting(true);
    setError(null);
    try {
      const text = await gitApi.draft(sessionId);
      setMessage(text.message);
      setTitle(text.title);
      setBody(text.body);
      setSource(text.source);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setDrafting(false);
    }
  }
  useEffect(() => void draft(), [sessionId]);

  async function run(action: 'commit' | 'push' | 'pr') {
    setBusy(true);
    setError(null);
    try {
      const out = await gitApi.run(sessionId, { action, message, ...(action === 'pr' ? { title, body } : {}) });
      setResult(out);
      void queries.invalidateQueries({ queryKey: ['git', sessionId] });
      void queries.invalidateQueries({ queryKey: ['files', sessionId] });
      void queries.invalidateQueries({ queryKey: ['task-prs'] });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const s = state.data;
  const dirty = (s?.files.length ?? 0) > 0;
  const canCommit = !!s?.isGit && dirty && message.trim() !== '';
  const pushable = !!s?.canPush && (dirty ? message.trim() !== '' : (s?.ahead ?? 0) > 0 || !s?.upstream);
  return (
    <DialogShell title="提交与推送" onClose={onClose}>
      <div data-testid="git-dialog" className="flex flex-col gap-3">
        <p className="text-sub text-primary">提交与推送</p>
        {state.isLoading ? <p className="text-meta text-tertiary">读取中…</p> : null}
        {s && !s.isGit ? <p className="text-meta text-tertiary">这个工作空间不是 git 仓库。</p> : null}
        {s?.isGit ? (
          <>
            <p className="font-mono text-meta text-secondary" data-testid="git-branch">
              {s.branch ?? '（分离 HEAD）'}{s.repo ? ` · ${s.repo}` : ''}{s.ahead > 0 ? ` · 领先 ${s.ahead}` : ''}
            </p>
            <div className="max-h-28 overflow-y-auto rounded-sm border border-hair bg-card px-2 py-1.5 font-mono text-[12px]" data-testid="git-files">
              {s.files.length === 0 ? <span className="text-tertiary">没有未提交的改动</span> : s.files.map((f) => (
                <div key={f.path} className="truncate text-secondary"><span className="mr-2 inline-block min-w-[1.5rem] text-tertiary">{STATUS[f.status] ?? f.status}</span>{f.path}</div>
              ))}
            </div>
            <label className="flex flex-col gap-1 text-meta text-secondary">
              <span className="flex items-center justify-between">
                提交说明
                <button type="button" className="text-accent disabled:opacity-40" disabled={drafting} onClick={() => void draft()} data-testid="git-redraft">
                  {drafting ? '起草中…' : source === 'model' ? '重新起草（模型）' : '重新起草'}
                </button>
              </span>
              <textarea className={`${INPUT} min-h-[84px] font-mono text-[12px]`} value={message} onChange={(e) => setMessage(e.target.value)} data-testid="git-message" />
            </label>
            {s.prBlocked === null ? (
              <>
                <label className="flex flex-col gap-1 text-meta text-secondary">
                  PR 标题
                  <input className={INPUT} value={title} onChange={(e) => setTitle(e.target.value)} data-testid="git-pr-title" />
                </label>
                <label className="flex flex-col gap-1 text-meta text-secondary">
                  PR 描述
                  <textarea className={`${INPUT} min-h-[64px] text-[12px]`} value={body} onChange={(e) => setBody(e.target.value)} data-testid="git-pr-body" />
                </label>
              </>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button className={SECONDARY_BUTTON} disabled={busy || !canCommit} onClick={() => void run('commit')} data-testid="git-commit">提交</button>
              <button className={SECONDARY_BUTTON} disabled={busy || !pushable} title={s.canPush ? undefined : '没有推送权限或没有 origin'} onClick={() => void run('push')} data-testid="git-push">
                {dirty ? '提交并推送' : '推送'}
              </button>
              <button className={PRIMARY_BUTTON} disabled={busy || !s.canPush || s.prBlocked !== null || title.trim() === ''} title={s.prBlocked ?? (s.prVia === 'token' ? '用团队 token 开 PR' : '用这台机器的 gh 开 PR')} onClick={() => void run('pr')} data-testid="git-pr">
                推送并开 PR
              </button>
            </div>
            {s.prBlocked ? <p className="text-[11px] text-tertiary" data-testid="git-pr-blocked">不能开 PR：{s.prBlocked}</p> : null}
            {s.pullRequests.length > 0 ? <PullRequestChips prs={s.pullRequests} /> : null}
          </>
        ) : null}
        {result ? (
          <div className="rounded-sm border border-hair bg-card p-2 text-meta text-secondary" data-testid="git-result">
            {result.committed && result.sha ? <p>已提交 <code>{result.sha.slice(0, 7)}</code></p> : null}
            {result.pushed ? <p>已推送到 {result.branch}</p> : null}
            {result.pullRequest ? <p>已开 PR：<a className="text-accent underline" href={result.pullRequest.url} target="_blank" rel="noreferrer" data-testid="git-result-pr">#{result.pullRequest.number}</a></p> : null}
            {result.compareUrl ? <p>没法自动开 PR，<a className="text-accent underline" href={result.compareUrl} target="_blank" rel="noreferrer" data-testid="git-compare">去 GitHub 新建</a></p> : null}
            {result.notes.map((n) => <p key={n} className="text-tertiary">{n}</p>)}
          </div>
        ) : null}
        {error ? <p className="text-meta text-danger" role="alert" data-testid="git-error">{error}</p> : null}
        <div className="flex justify-end"><button className={SECONDARY_BUTTON} onClick={onClose}>关闭</button></div>
      </div>
    </DialogShell>
  );
}

export function PullRequestChips({ prs }: { prs: readonly PullRequestDto[] }) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="pr-chips">
      {prs.map((pr) => (
        <a key={pr.id} href={pr.url} target="_blank" rel="noreferrer" data-testid="pr-chip" data-state={pr.state}
          className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${pr.state === 'merged' ? 'border-accent/60 text-accent' : pr.state === 'closed' ? 'border-hair text-tertiary line-through' : 'border-sage/60 text-sage'}`}>
          PR #{pr.number} · {pr.state === 'merged' ? '已合并' : pr.state === 'closed' ? '已关闭' : '进行中'}
        </a>
      ))}
    </div>
  );
}

/** 团队设置里的「代码托管」：GitHub token 只回有没有 + 末 4 位。 */
export function GitHostTokenPanel() {
  const queries = useQueryClient();
  const status = useQuery({ queryKey: ['git-host-token'], queryFn: gitApi.token, retry: false });
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      setToken('');
      void queries.invalidateQueries({ queryKey: ['git-host-token'] });
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  if (status.isError) return null; // 没权限就不显示
  const s = status.data;
  return (
    <section className="mt-4 rounded-sm border border-hair bg-card p-3" data-testid="git-host-panel">
      <p className="text-sub text-primary">代码托管</p>
      <p className="mt-1 text-meta text-tertiary">团队的 GitHub token：开 PR 时优先用它，没有就用机器上登录的 gh，再不行只推送并给链接。</p>
      <p className="mt-2 text-meta text-secondary" data-testid="git-host-status">{s?.configured ? `已配置 · 末 4 位 ${s.last4}` : '未配置'}</p>
      <div className="mt-2 flex gap-2">
        <input type="password" autoComplete="off" className={INPUT} placeholder="ghp_… / github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} data-testid="git-host-input" />
        <button className={PRIMARY_BUTTON} disabled={token.trim() === ''} onClick={() => void act(() => gitApi.setToken(token))} data-testid="git-host-save">保存</button>
        {s?.configured ? <button className={SECONDARY_BUTTON} onClick={() => void act(gitApi.removeToken)} data-testid="git-host-remove">移除</button> : null}
      </div>
      {error ? <p className="mt-1 text-meta text-danger" role="alert">{error}</p> : null}
    </section>
  );
}
