import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto } from '../../shell/api.ts';
import { api } from '../../shell/api.ts';
import { useAccount } from '../../shell/auth.tsx';
import { canAdminister } from '../../shell/account-context.ts';
import { SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';
import {
  WORKTREE_TIMEOUT_DEFAULT,
  WORKTREE_TIMEOUT_MAX,
  WORKTREE_TIMEOUT_MIN,
  projectWorktree,
  worktreeDraft,
  worktreeDraftProblem,
  worktreePayload,
  type ProjectWorktreeConfig,
  type WorktreeDraft
} from './worktree-config.ts';

/**
 * 项目设置 · 工作空间 · 「隔离与准备」（docs/design/worktree.md §3 §7）。
 *
 * 只放两件事：新任务默认在哪种目录里干活（共用长期空间 / 每个任务开独立 worktree），
 * 以及 worktree 建好之后自动跑什么命令。命令只来自项目配置、不来自每次请求——这是
 * 「项目管理员能在机器上跑一条命令」的同一信任级别，所以只有 owner / admin 能改。
 */
export function WorktreeSettings({ project }: { project: ProjectDto }) {
  const account = useAccount();
  const editable = canAdminister(account);
  const queryClient = useQueryClient();
  const stored = JSON.stringify(projectWorktree(project));
  const [draft, setDraft] = useState<WorktreeDraft>(() => worktreeDraft(project));
  // 别人（或另一个标签页）改了配置、画布刷新后把草稿拉回已保存的样子；自己的输入不会被 polling 冲掉
  useEffect(() => {
    setDraft(worktreeDraft(project));
  }, [stored]);

  const problem = editable ? worktreeDraftProblem(draft) : null;
  const dirty = editable && JSON.stringify(worktreeDraft(project)) !== JSON.stringify(draft);
  const save = useMutation({
    mutationFn: () => api.saveProjectWorktree(project.id, worktreePayload(draft)),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['home'] }),
        queryClient.invalidateQueries({ queryKey: ['canvas', project.id] })
      ]);
    }
  });

  const update = (patch: Partial<WorktreeDraft>) => {
    // 一改就清掉上一次保存的失败 / 成功提示：那是针对旧值的结论
    if (save.isError || save.isSuccess) save.reset();
    setDraft((current) => ({ ...current, ...patch }));
  };
  const error = problem ?? save.error?.message ?? null;

  return (
    <section className="mb-3 border-b border-hair pb-3" data-testid="worktree-config">
      <h3 className="mb-1 text-sub text-primary">隔离与准备</h3>
      <p className="mb-2 text-meta text-tertiary">
        每个任务在哪种目录里干活。隔离档会在项目仓库旁边开一个独立的 worktree 和新分支，任务之间互不踩脚。
      </p>

      {editable ? (
        <>
          <div role="radiogroup" aria-label="默认目录档位" className="mb-2 space-y-1">
            <label className="flex items-start gap-2 text-sub text-secondary">
              <input
                type="radio"
                name="worktree-mode"
                className="mt-0.5"
                data-testid="worktree-mode-shared"
                checked={draft.mode === 'shared'}
                onChange={() => update({ mode: 'shared' })}
              />
              <span className="min-w-0">
                <span className="block text-primary">共用长期空间（默认）</span>
                <span className="block text-meta text-tertiary">单人顺序干活、要看到别人未提交的改动时选这个。</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sub text-secondary">
              <input
                type="radio"
                name="worktree-mode"
                className="mt-0.5"
                data-testid="worktree-mode-isolated"
                checked={draft.mode === 'isolated'}
                onChange={() => update({ mode: 'isolated' })}
              />
              <span className="min-w-0">
                <span className="block text-primary">每个任务开独立 worktree</span>
                <span className="block text-meta text-tertiary">并行任务 / 会开 PR 时选这个。</span>
              </span>
            </label>
          </div>

          <label className="mb-1 block text-meta text-secondary" htmlFor="worktree-command">准备命令（可留空）</label>
          <p className="mb-1 text-meta text-tertiary">
            建好 worktree 后在这台机器上、以 worker 用户身份执行；比如装依赖、跑迁移。留空就什么都不跑。
            {draft.mode === 'shared' ? '当前档位是共用空间，命令只在开了 worktree 的任务里跑。' : ''}
          </p>
          <textarea
            id="worktree-command"
            data-testid="worktree-setup-command"
            className="block min-h-[64px] w-full resize-y rounded-sm border border-hair bg-card px-2 py-1.5 font-mono text-sub text-primary outline-none placeholder:text-tertiary focus:border-accent"
            placeholder="npm ci"
            value={draft.command}
            onChange={(event) => update({ command: event.target.value })}
          />

          <label className="mt-2 flex items-start gap-2 text-meta text-secondary">
            <input
              type="checkbox"
              className="mt-0.5"
              data-testid="worktree-wait"
              checked={draft.waitForSetup}
              onChange={(event) => update({ waitForSetup: event.target.checked })}
            />
            <span>
              等待准备完成再启动 agent
              <span className="block text-tertiary">不勾的话命令在后台跑，会话可以先开，但工具调用可能因为依赖没装好而失败。</span>
            </span>
          </label>

          <label className="mt-2 flex flex-wrap items-center gap-2 text-meta text-secondary" htmlFor="worktree-timeout">
            超时
            <input
              id="worktree-timeout"
              type="text"
              inputMode="numeric"
              data-testid="worktree-timeout"
              className="w-16 rounded-sm border border-hair bg-card px-1.5 py-0.5 text-meta text-primary outline-none focus:border-accent"
              value={draft.timeout}
              onChange={(event) => update({ timeout: event.target.value })}
            />
            秒（{WORKTREE_TIMEOUT_MIN}–{WORKTREE_TIMEOUT_MAX}，默认 {WORKTREE_TIMEOUT_DEFAULT}）
          </label>

          {error ? (
            <p className="mt-1 text-meta text-rust" data-testid="worktree-error">{error}</p>
          ) : null}
          <div className="mt-2 flex items-center justify-end gap-2">
            {save.isSuccess && !dirty ? <span className="text-meta text-tertiary">已保存</span> : null}
            <button
              type="button"
              className={SECONDARY_BUTTON}
              data-testid="worktree-save"
              disabled={!dirty || problem !== null || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? '保存中…' : '保存'}
            </button>
          </div>
        </>
      ) : (
        <ReadonlyWorktree config={projectWorktree(project)} />
      )}
    </section>
  );
}

/** 非管理员看到的是同一份事实，只是不能改：别让「为什么没有开关」变成疑问。 */
function ReadonlyWorktree({ config }: { config: ProjectWorktreeConfig | null }) {
  return (
    <div className="space-y-1 text-meta text-secondary" data-testid="worktree-readonly">
      <p>默认：{(config?.mode ?? 'shared') === 'isolated' ? '每个任务开独立 worktree' : '共用长期空间（默认）'}</p>
      <p>
        准备命令：
        {config?.setup ? (
          <span className="ml-1 break-all font-mono text-tertiary">{config.setup.command}</span>
        ) : (
          <span className="ml-1 text-tertiary">不跑</span>
        )}
      </p>
      {config?.setup ? (
        <p className="text-tertiary">
          {config.setup.waitForSetup ? '等准备完成再启动 agent' : '准备命令在后台跑'} · 超时 {config.setup.timeoutSeconds} 秒
        </p>
      ) : null}
      <p className="text-tertiary">只有项目主人 / 管理员能改这块。</p>
    </div>
  );
}
