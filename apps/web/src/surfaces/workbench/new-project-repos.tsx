import { INPUT } from '../../shell/dialog-shell.tsx';
import { PROJECT_REPOS_MAX, REPO_TOKEN_MAX, repoUrlPatch, type ProjectRepoRow } from './project-repos.ts';
import { newProjectRepoRow, newProjectRepoRowProblem, newProjectReposSummary } from './new-project-repos.ts';

/**
 * 新建项目里的「git 仓库（可选）」。
 *
 * 默认折叠，不挡项目名 / 说明这条主路径；展开后可以登记 0..8 个仓库，
 * 每行独立填地址、默认分支和访问令牌，并可选一个主仓库。
 * 这里只登记，不 clone、不建任务——那些要等开始任务时选好机器和工作目录。
 */
export function NewProjectRepos({
  open,
  onToggle,
  rows,
  primaryRepoId,
  error,
  onChange
}: {
  open: boolean;
  onToggle: () => void;
  rows: readonly ProjectRepoRow[];
  primaryRepoId: string | null;
  /** 提交时才发现的问题（例如主仓库不在清单里）；行内问题不重复放这里。 */
  error: string | null;
  onChange: (rows: readonly ProjectRepoRow[], primaryRepoId: string | null) => void;
}) {
  const summary = newProjectReposSummary(rows);

  const update = (index: number, patch: Partial<ProjectRepoRow>) => {
    onChange(
      rows.map((row, at) => (at === index ? { ...row, ...patch } : row)),
      primaryRepoId
    );
  };

  const add = () => {
    if (rows.length >= PROJECT_REPOS_MAX) return;
    onChange([...rows, newProjectRepoRow(rows)], primaryRepoId);
  };

  const remove = (index: number) => {
    const row = rows[index];
    if (row === undefined) return;
    onChange(
      rows.filter((_, at) => at !== index),
      primaryRepoId === row.id ? null : primaryRepoId
    );
  };

  const togglePrimary = (id: string) => {
    onChange(rows, primaryRepoId === id ? null : id);
  };

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="new-project-repos"
        className="mb-2 flex min-h-[36px] w-full min-w-0 items-center gap-1.5 text-left text-meta text-secondary hover:text-primary"
        onClick={onToggle}
      >
        <span aria-hidden className="inline-block w-3 shrink-0 text-center">{open ? '▾' : '▸'}</span>
        <span className="shrink-0">git 仓库（可选）</span>
        {!open && summary !== '' ? (
          <span className="min-w-0 truncate text-tertiary" data-testid="new-project-repos-summary">
            · {summary}
          </span>
        ) : null}
      </button>

      {open ? (
        <div id="new-project-repos" className="mb-3 space-y-2" data-testid="new-project-repos">
          <p className="text-meta text-tertiary">
            只登记仓库，不会现在下载；开始任务、选好机器和工作目录后再克隆。
          </p>

          {rows.length === 0 ? (
            <div
              className="rounded-sm border border-dashed border-hair px-3 py-2.5 text-meta text-tertiary"
              data-testid="new-project-repos-empty"
            >
              还没有仓库。也可以先不绑，建好项目后再在「项目设置 → 代码与工作目录」里添加。
            </div>
          ) : null}

          {rows.map((row, index) => {
            const primary = primaryRepoId === row.id;
            const rowProblem = newProjectRepoRowProblem(row, rows);
            return (
              <div
                key={row.id}
                className="rounded-sm border border-hair bg-card p-2.5"
                data-testid="new-project-repo-row"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="flex min-w-0 flex-wrap items-center gap-2 text-meta text-tertiary">
                    {primary ? (
                      <span
                        className="rounded-sm border border-hair px-1.5 py-0.5 text-secondary"
                        data-testid="new-project-repo-primary-badge"
                      >
                        主仓库
                      </span>
                    ) : (
                      <span>仓库 {index + 1}</span>
                    )}
                    <button
                      type="button"
                      aria-pressed={primary}
                      aria-label={primary ? `取消仓库 ${index + 1} 的主仓库` : `把仓库 ${index + 1} 设为主仓库`}
                      className="text-meta text-secondary hover:text-primary"
                      data-testid="new-project-repo-primary"
                      onClick={() => togglePrimary(row.id)}
                    >
                      {primary ? '取消主仓库' : '设为主仓库'}
                    </button>
                  </span>
                  <button
                    type="button"
                    aria-label={`删除仓库 ${index + 1}`}
                    className="shrink-0 text-meta text-tertiary hover:text-rust"
                    data-testid="new-project-repo-remove"
                    onClick={() => remove(index)}
                  >
                    删除
                  </button>
                </div>

                <div className="grid gap-2 md:grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)_minmax(0,0.8fr)]">
                  <label className="block min-w-0 text-meta text-secondary">
                    仓库名
                    <input
                      className={`${INPUT} mt-0.5`}
                      aria-label={`仓库 ${index + 1} 名称`}
                      placeholder="api"
                      spellCheck={false}
                      autoCapitalize="off"
                      value={row.name}
                      onChange={(event) => update(index, { name: event.target.value })}
                    />
                  </label>
                  <label className="block min-w-0 text-meta text-secondary">
                    地址
                    <input
                      className={`${INPUT} mt-0.5 font-mono`}
                      aria-label={`仓库 ${index + 1} 地址`}
                      placeholder="https://… 或 git@…"
                      spellCheck={false}
                      autoCapitalize="off"
                      value={row.url}
                      onChange={(event) => update(index, repoUrlPatch(row, event.target.value))}
                    />
                  </label>
                  <label className="block min-w-0 text-meta text-secondary">
                    默认分支
                    <input
                      className={`${INPUT} mt-0.5 font-mono`}
                      aria-label={`仓库 ${index + 1} 默认分支`}
                      placeholder="main（可选）"
                      spellCheck={false}
                      autoCapitalize="off"
                      value={row.defaultBranch}
                      onChange={(event) => update(index, { defaultBranch: event.target.value })}
                    />
                  </label>
                </div>

                <label className="mt-2 block min-w-0 text-meta text-secondary">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    访问令牌
                    <span className="text-tertiary">可选</span>
                  </span>
                  <input
                    className={`${INPUT} mt-0.5 w-full font-mono`}
                    aria-label={`仓库 ${index + 1} 访问令牌`}
                    type="password"
                    autoComplete="off"
                    maxLength={REPO_TOKEN_MAX}
                    placeholder={row.hasToken ? '已配置；留空不改' : '私有 HTTPS 仓库的 access token'}
                    value={row.credential}
                    onChange={(event) => update(index, { credential: event.target.value, clearToken: false })}
                  />
                </label>

                {rowProblem !== null ? (
                  <p className="mt-1 text-meta text-rust" data-testid="new-project-repo-problem">
                    {rowProblem}
                  </p>
                ) : null}
              </div>
            );
          })}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              className="text-meta text-secondary hover:text-primary disabled:opacity-40"
              data-testid="new-project-add-repo"
              disabled={rows.length >= PROJECT_REPOS_MAX}
              onClick={add}
            >
              添加仓库
            </button>
            <span className="text-meta text-tertiary">
              {rows.length === 0 ? `最多 ${PROJECT_REPOS_MAX} 个` : `${rows.length} / ${PROJECT_REPOS_MAX}`}
            </span>
          </div>

          <div className="space-y-1 text-meta text-tertiary">
            <p>私有 HTTPS 仓库把令牌填在行内；令牌只写不回，创建后不再显示。SSH 地址用机器上的 key。</p>
            <p>主仓库可选：指定后才能开组合会话；不指定就按单仓使用。</p>
          </div>

          {error !== null ? (
            <p role="alert" className="text-meta text-rust" data-testid="new-project-repos-error">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
