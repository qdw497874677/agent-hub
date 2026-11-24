import { useEffect, useState } from 'react';
import { SaveStatus } from '../../atoms/save-status.tsx';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto } from '../../shell/api.ts';
import { api } from '../../shell/api.ts';
import { projectKeys } from '../../shell/query-keys.ts';
import { useAccount } from '../../shell/auth.tsx';
import { canAdminister } from '../../shell/account-context.ts';
import { SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';
import {
  CHECK_COMMANDS_MAX,
  checksDirty,
  checksDraft,
  checksDraftProblem,
  parseChecks
} from './project-checks.ts';

/**
 * 项目设置 · 代码与工作目录 · 「检查命令」（issue #216 P1）。
 *
 * agent 会用 `run.checks` 按顺序跑这些命令，遇到第一个失败就停——所以这是「项目里能让人在机器上
 * 跑一串命令」的入口，和准备命令同一信任级别：只有 owner / admin 能改。
 * 没有默认值：不同项目该跑什么完全不一样，猜一个错的比空着更糟。
 */
export function ProjectChecksSettings({ project }: { project: ProjectDto }) {
  const account = useAccount();
  const editable = canAdminister(account);
  const queryClient = useQueryClient();
  const stored = JSON.stringify(project.checks ?? []);
  const [text, setText] = useState(() => checksDraft(project));
  // 别人（或另一个标签页）改了配置、画布刷新后把草稿拉回已保存的样子；自己正在打的字不被 polling 冲掉。
  useEffect(() => {
    setText(checksDraft(project));
  }, [stored]);

  const save = useMutation({
    mutationFn: () => api.saveProjectChecks(project.id, parseChecks(text)),
    onSuccess: (next) => {
      // 和预览端口那段一致：画布缓存里换掉这个项目，列表也跟着失效。
      queryClient.setQueryData(projectKeys.canvas(next.id), (old: unknown) =>
        old !== null && typeof old === 'object' && 'project' in old ? { ...(old as object), project: next } : old
      );
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    }
  });

  const checks = parseChecks(text);
  const problem = editable ? checksDraftProblem(text) : null;
  const dirty = editable && checksDirty(project, text);
  const overLimit = checks.length > CHECK_COMMANDS_MAX;

  const update = (value: string) => {
    // 一改就清掉上一次保存的失败 / 成功提示：那是针对旧值的结论。
    if (save.isError || save.isSuccess) save.reset();
    setText(value);
  };

  return (
    <section className="mt-5 border-t border-hair pt-4" data-testid="project-checks-section">
      <h3 className="mb-1 flex flex-wrap items-baseline gap-x-2 text-sub text-primary">
        检查命令
        <span className="text-meta text-tertiary">agent 跑什么</span>
      </h3>
      <p className="mb-2 text-meta text-tertiary">
        agent 会用 <code className="font-mono">run.checks</code> 在机器上按顺序跑；遇到第一个失败就停。一行一条，最多 {CHECK_COMMANDS_MAX} 条。
      </p>
      <textarea
        id="project-checks"
        data-testid="project-checks"
        aria-label="检查命令，一行一条"
        rows={4}
        className="block min-h-[88px] w-full resize-y rounded-sm border border-hair bg-card px-2 py-1.5 font-mono text-sub text-primary outline-none placeholder:text-tertiary focus:border-ring disabled:opacity-50"
        placeholder={'npm run typecheck\nnpm test'}
        value={text}
        disabled={!editable}
        onChange={(event) => update(event.target.value)}
      />
      {problem !== null ? (
        <p className="mt-2 text-meta text-rust" data-testid="project-checks-error">{problem}</p>
      ) : save.error ? (
        <p className="mt-2 text-meta text-rust" data-testid="project-checks-error">{save.error.message}</p>
      ) : null}
      {!editable ? <p className="mt-1 text-meta text-tertiary">需要项目所有者权限。</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`mr-auto text-meta ${overLimit ? 'text-rust' : 'text-tertiary'}`}>
          {checks.length} / {CHECK_COMMANDS_MAX} 条
        </span>
        <SaveStatus dirty={dirty} saved={save.isSuccess} testId="project-checks-saved" />
        <button
          type="button"
          className={SECONDARY_BUTTON}
          data-testid="project-checks-save"
          disabled={!editable || !dirty || problem !== null || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? '保存中…' : '保存检查命令'}
        </button>
      </div>
    </section>
  );
}
