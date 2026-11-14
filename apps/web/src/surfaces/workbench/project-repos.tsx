import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto } from '../../shell/api.ts';
import { api } from '../../shell/api.ts';
import { useAccount } from '../../shell/auth.tsx';
import { canAdminister } from '../../shell/account-context.ts';
import { INPUT, SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';
import {
  PROJECT_REPOS_MAX,
  emptyRepoRow,
  repoRowsProblem,
  repoRowsValue,
  repoRowsFrom,
  repoRowProblem,
  reposDirty,
  type ProjectRepoRow
} from './project-repos.ts';

/**
 * 项目设置 · 代码与空间 · 「仓库」（docs/design/multi-repo.md §7）。
 *
 * 一个项目最多 8 个仓库；第一行是主仓库（组合工作空间的入口 / 老 `repo` 字段的来源），
 * 能改不能删。仓库名就是组合工作空间里的子目录名，所以这里同时给出名字规则。
 * 和「隔离与准备」放在一起：两件事合起来才决定「这个项目开出来的空间长什么样」。
 */
export function ProjectRepos({ project }: { project: ProjectDto }) {
  const account = useAccount();
  const editable = canAdminister(account);
  const queryClient = useQueryClient();
  const stored = JSON.stringify(repoRowsFrom(project));
  const [rows, setRows] = useState<readonly ProjectRepoRow[]>(() => repoRowsFrom(project));
  // 画布轮询 / 别人改了仓库清单时把草稿拉回已保存的样子，但自己不丢正在编辑的内容
  useEffect(() => {
    setRows(repoRowsFrom(project));
  }, [stored]);

  const problem = editable ? repoRowsProblem(rows) : null;
  const dirty = editable && reposDirty(rows, repoRowsFrom(project));
  const save = useMutation({
    mutationFn: () => api.saveProjectRepos(project.id, repoRowsValue(rows)),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['home'] }),
        queryClient.invalidateQueries({ queryKey: ['canvas', project.id] })
      ]);
    }
  });

  const update = (index: number, patch: Partial<ProjectRepoRow>) => {
    // 一改就清掉上一次保存的失败 / 成功提示：那是针对旧值的结论
    if (save.isError || save.isSuccess) save.reset();
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };
  const add = () => {
    if (save.isError || save.isSuccess) save.reset();
    setRows((current) => (current.length >= PROJECT_REPOS_MAX ? current : [...current, emptyRepoRow()]));
  };
  const remove = (index: number) => {
    if (save.isError || save.isSuccess) save.reset();
    setRows((current) => current.filter((_, at) => at !== index));
  };
  const error = problem ?? save.error?.message ?? null;

  return (
    <section data-testid="project-repos">
      <h3 className="mb-1 flex flex-wrap items-baseline gap-x-2 text-sub text-primary">
        仓库
        <span className="text-meta text-tertiary">代码从哪来</span>
      </h3>
      <p className="mb-2 text-meta text-tertiary">
        项目绑定的代码仓库，最多 {PROJECT_REPOS_MAX} 个。第一条是主仓库；仓库名会用作组合工作空间里的子目录名。
      </p>

      {editable ? (
        <>
          <div className="space-y-2">
            {rows.length === 0 ? (
              <p className="text-meta text-tertiary" data-testid="repos-empty">
                这个项目还没绑仓库。绑上之后，派生任务时就能在仓库上开 worktree 或组合工作空间。
              </p>
            ) : null}
            {rows.map((row, index) => {
              const rowProblem = repoRowProblem(row, rows);
              return (
                <div
                  key={row.id === '' ? `new-${index}` : row.id}
                  className="rounded-sm border border-hair bg-card p-2"
                  data-testid="repo-row"
                >
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-meta text-tertiary">
                      {index === 0 ? (
                        <span className="rounded-sm border border-hair px-1.5 py-0.5 text-meta text-secondary" data-testid="repo-primary">
                          主仓库
                        </span>
                      ) : (
                        <span>仓库 {index + 1}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      className="text-meta text-tertiary hover:text-rust disabled:opacity-40"
                      data-testid="repo-remove"
                      disabled={index === 0}
                      title={index === 0 ? '主仓库不能删；换一个主仓库请直接改这一行' : '从清单里删掉这个仓库'}
                      onClick={() => remove(index)}
                    >
                      删除
                    </button>
                  </div>
                  <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,0.8fr)]">
                    <label className="block text-meta text-secondary">
                      仓库名
                      <input
                        className={`${INPUT} mt-0.5`}
                        data-testid="repo-name"
                        aria-label="仓库名"
                        placeholder="api"
                        value={row.name}
                        onChange={(event) => update(index, { name: event.target.value })}
                      />
                    </label>
                    <label className="block text-meta text-secondary">
                      地址
                      <input
                        className={`${INPUT} mt-0.5`}
                        data-testid="repo-url"
                        aria-label="仓库地址"
                        placeholder="git@github.com:acme/api.git"
                        value={row.url}
                        onChange={(event) => update(index, { url: event.target.value })}
                      />
                    </label>
                    <label className="block text-meta text-secondary">
                      默认分支
                      <input
                        className={`${INPUT} mt-0.5`}
                        data-testid="repo-branch"
                        aria-label="默认分支"
                        placeholder="main"
                        value={row.defaultBranch}
                        onChange={(event) => update(index, { defaultBranch: event.target.value })}
                      />
                    </label>
                  </div>
                  {rowProblem !== null ? <p className="mt-1 text-meta text-rust">{rowProblem}</p> : null}
                </div>
              );
            })}
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              className="text-meta text-secondary hover:text-primary disabled:opacity-40"
              data-testid="repo-add"
              disabled={rows.length >= PROJECT_REPOS_MAX}
              onClick={add}
            >
              添加仓库
            </button>
            <div className="flex flex-wrap items-center gap-2">
              {save.isSuccess && !dirty ? <span className="text-meta text-tertiary">已保存</span> : null}
              <button
                type="button"
                className={SECONDARY_BUTTON}
                data-testid="repos-save"
                disabled={!dirty || problem !== null || save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? '保存中…' : '保存仓库'}
              </button>
            </div>
          </div>
          {error !== null ? (
            <p className="mt-1 text-meta text-rust" data-testid="repos-error">{error}</p>
          ) : null}
        </>
      ) : (
        <ReadonlyRepos rows={repoRowsFrom(project)} />
      )}
    </section>
  );
}

/** 非管理员看到同一份清单，只是不能改：别让「为什么没有输入框」变成疑问。 */
function ReadonlyRepos({ rows }: { rows: readonly ProjectRepoRow[] }) {
  if (rows.length === 0) {
    return <p className="text-meta text-tertiary" data-testid="project-repos-readonly">这个项目还没绑仓库。</p>;
  }
  return (
    <ul className="space-y-1 text-meta text-secondary" data-testid="project-repos-readonly">
      {rows.map((row, index) => (
        <li key={row.id === '' ? `repo-${index}` : row.id} className="flex flex-wrap items-baseline gap-x-2">
          {index === 0 ? <span className="rounded-sm border border-hair px-1.5 py-0.5 text-meta text-tertiary">主仓库</span> : null}
          <span className="text-primary">{row.name}</span>
          <span className="break-all text-tertiary">{row.url}</span>
          <span className="text-tertiary">{row.defaultBranch === '' ? 'main' : row.defaultBranch}</span>
        </li>
      ))}
      <li className="text-tertiary">只有项目主人 / 管理员能改这块。</li>
    </ul>
  );
}
