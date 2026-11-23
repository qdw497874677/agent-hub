import { useEffect, useRef, useState } from 'react';
import { SaveStatus } from '../../atoms/save-status.tsx';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto } from '../../shell/api.ts';
import { api } from '../../shell/api.ts';
import { useAccount } from '../../shell/auth.tsx';
import { canAdminister } from '../../shell/account-context.ts';
import { INPUT, SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';
import { useWorkers } from '../../shell/workers.tsx';
import {
  PROJECT_REPOS_MAX,
  REPO_TOKEN_MAX,
  clearCredential,
  emptyRepoRow,
  repoCheckBlocksSave,
  repoCheckSummary,
  repoProbeAffected,
  repoRowsProblem,
  repoRowsValue,
  primaryRepoIdFrom,
  repoRowsFrom,
  repoRowProblem,
  reposDirty,
  repoUrlPatch,
  type ProjectRepoRow,
  type ProjectRepoValue,
  type ReposCheck
} from './project-repos.ts';
import { RepoProbeHint, RepoProbeMachine, RepoProbeStatus, useRepoProbes } from './repo-probe.tsx';

/**
 * 项目设置 · 代码与工作目录 · 「仓库」（docs/design/multi-repo.md §7）。
 *
 * 一个项目最多 8 个仓库。可指定其中一个为主仓库：组合会话的 cwd 就在它的 worktree 里。
 * 不指定主仓库则只有单仓会话。仓库名就是子目录名（不能叫 repos）。
 */
export function ProjectRepos({ project }: { project: ProjectDto }) {
  const account = useAccount();
  const editable = canAdminister(account);
  const queryClient = useQueryClient();
  const stored = JSON.stringify(repoRowsFrom(project));
  const storedPrimary = primaryRepoIdFrom(project);
  const [rows, setRows] = useState<readonly ProjectRepoRow[]>(() => repoRowsFrom(project));
  const [primaryRepoId, setPrimaryRepoId] = useState<string | null>(storedPrimary);
  // 画布轮询 / 别人改了仓库清单时把草稿拉回已保存的样子，但自己不丢正在编辑的内容
  useEffect(() => {
    setRows(repoRowsFrom(project));
    setPrimaryRepoId(storedPrimary);
  }, [stored, storedPrimary]);

  const problem = editable ? repoRowsProblem(rows) : null;
  const dirty = editable && (reposDirty(rows, repoRowsFrom(project)) || primaryRepoId !== storedPrimary);
  // 上一次「检查仓库」的结论；unavailable 时另一条提示说明这次没查成
  const [check, setCheck] = useState<ReposCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [skipped, setSkipped] = useState<string | null>(null);
  // 检查是异步的：回来时草稿可能又被改过，这时存的是旧值，宁可不存
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // 单行检查：不保存、不创建、不 clone，只让选中的机器试着读一下
  const workers = useWorkers();
  const [probeWorkerId, setProbeWorkerId] = useState<string | null>(null);
  // 保存前的整份检查在途时换了机器：晚到的结论不属于眼前这台机器，不能拿来挡保存/铺到行里
  const probeWorkerIdRef = useRef(probeWorkerId);
  probeWorkerIdRef.current = probeWorkerId;
  const probes = useRepoProbes((repo, workerId) => api.checkProjectRepos(project.id, [repo], workerId));
  const probesRef = useRef(probes);
  probesRef.current = probes;
  // 已保存清单被外面改掉时，行号可能对不上，旧结论一律不要
  useEffect(() => {
    probesRef.current.clear();
  }, [stored, storedPrimary, project.id]);

  const save = useMutation({
    mutationFn: (input: { repos: readonly ProjectRepoValue[]; primaryRepoId: string | null }) =>
      api.saveProjectRepos(project.id, input.repos, input.primaryRepoId),
    onSuccess: async () => {
      // 结论已经被用掉了：别让过期的检查结果继续挂在界面上
      setCheck(null);
      setSkipped(null);
      probesRef.current.clear();
      // 令牌已经存进去了：草稿里那份明文马上丢掉，别留在输入框里
      setRows((current) => current.map((row) => ({ ...row, credential: '', clearToken: false })));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['home'] }),
        queryClient.invalidateQueries({ queryKey: ['canvas', project.id] })
      ]);
    }
  });

  /** 检查结论只对当时的值有效：一改草稿（或开始下一轮）就清掉。 */
  const resetCheck = () => {
    setCheck(null);
    setSkipped(null);
  };
  // 点「仍然保存」= 跳过检查，直接走原来的保存
  const forceSave = () => {
    resetCheck();
    probes.clear();
    save.mutate({ repos: repoRowsValue(rows), primaryRepoId });
  };
  /**
   * 「保存仓库」= 先检查再保存（仓库能不能 clone、分支存不存在，别等派生任务才报错）。
   * 检查接口自己失败（网络 / 500）不挡保存：让 PATCH 去给结论，总比卡住人强。
   */
  const checkThenSave = async () => {
    if (checking || save.isPending) return;
    if (save.isError || save.isSuccess) save.reset();
    resetCheck();
    const snapshot = repoRowsValue(rows);
    const serialized = JSON.stringify(snapshot);
    const workerId = probeWorkerId;
    setChecking(true);
    let result: ReposCheck | null = null;
    try {
      // 保存前的整份检查也听同一台机器的选择，别出现「明明选了 omarchy，却在别处查」
      result = await api.checkProjectRepos(project.id, snapshot, workerId);
    } catch {
      result = null;
    }
    setChecking(false);
    // 等结果的这段时间里又改了草稿：这次检查说的不是眼前的值，留着下次再存
    if (JSON.stringify(repoRowsValue(rowsRef.current)) !== serialized) return;
    // 换过机器：结论和眼前的选择对不上，别保存，也别把结论挂出来
    if (probeWorkerIdRef.current !== workerId) return;
    if (result !== null) {
      // 保存前这轮整份检查也铺到每一行，别让行里还挂着更早的结论
      probes.apply(result);
    }
    if (result !== null && repoCheckBlocksSave(result)) {
      setCheck(result);
      return;
    }
    if (result !== null) setSkipped(result.unavailable);
    save.mutate({ repos: snapshot, primaryRepoId });
  };

  /** 单行检查：只把这一行发给后端试读，不碰保存 / 创建 / clone。 */
  const checkRow = (index: number) => {
    const row = rows[index];
    if (row === undefined) return;
    if (checking || save.isPending) return;
    const value = repoRowsValue([row])[0];
    if (value === undefined) return;
    if (save.isError || save.isSuccess) save.reset();
    // 单行重查会推翻整份检查里的那一条：旧的总结 / 「仍然保存」不要再挂着
    resetCheck();
    probes.check(index, value, probeWorkerId);
  };

  const update = (index: number, patch: Partial<ProjectRepoRow>) => {
    // 一改就清掉上一次保存的失败 / 成功提示：那是针对旧值的结论
    if (save.isError || save.isSuccess) save.reset();
    resetCheck();
    // 地址 / 分支 / 令牌一变，行的检查结论就不再是眼前这行的了（请求在路上也一样）
    if (repoProbeAffected(patch)) probes.invalidate(index);
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };
  const add = () => {
    if (save.isError || save.isSuccess) save.reset();
    resetCheck();
    probes.clear();
    setRows((current) => (current.length >= PROJECT_REPOS_MAX ? current : [...current, emptyRepoRow()]));
  };
  const remove = (index: number) => {
    if (save.isError || save.isSuccess) save.reset();
    resetCheck();
    // 删掉中间一行会让后面的行号前移，旧结论按行号对不上，全部清掉
    probes.clear();
    setRows((current) => current.filter((_, at) => at !== index));
  };
  const error = problem ?? save.error?.message ?? null;
  const checkSummary = check === null ? null : repoCheckSummary(check);

  return (
    <section data-testid="project-repos">
      <h3 className="mb-1 flex flex-wrap items-baseline gap-x-2 text-sub text-primary">
        仓库
      </h3>
      <p className="mb-2 text-meta text-tertiary" title="仓库名会用作组合工作目录里的子目录名">
        最多 {PROJECT_REPOS_MAX} 个。指定主仓库后才能开组合会话。
      </p>

      {editable ? (
        <>
          {rows.length > 0 ? (
            <>
              <RepoProbeMachine
                workers={workers.list}
                value={probeWorkerId}
                onChange={(id) => {
                  // 换机器 = 之前的结论不再代表这台机器；在途的保存前检查也立刻作废
                  probeWorkerIdRef.current = id;
                  setProbeWorkerId(id);
                  probes.clear();
                }}
              />
              <div className="mb-2">
                <RepoProbeHint />
              </div>
            </>
          ) : null}
          <div className="space-y-2">
            {rows.length === 0 ? (
              <p className="text-meta text-tertiary" data-testid="repos-empty">
                还没有仓库。
              </p>
            ) : null}
            {rows.map((row, index) => {
              const rowProblem = repoRowProblem(row, rows);
              const probe = probes.get(index);
              const rowChecking = probe?.state === 'checking';
              return (
                <div
                  key={row.id === '' ? `new-${index}` : row.id}
                  className="rounded-sm border border-hair bg-card p-2"
                  data-testid="repo-row"
                >
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-meta text-tertiary">
                      {row.id !== '' && primaryRepoId === row.id ? (
                        <span className="rounded-sm border border-hair px-1.5 py-0.5 text-meta text-secondary" data-testid="repo-primary">
                          主仓库
                        </span>
                      ) : (
                        <span>仓库 {index + 1}</span>
                      )}
                      {editable && row.id !== '' ? (
                        <button
                          type="button"
                          className="text-meta text-secondary hover:text-primary"
                          data-testid="repo-set-primary"
                          onClick={() => {
                            if (save.isError || save.isSuccess) save.reset();
                            resetCheck();
                            setPrimaryRepoId((current) => (current === row.id ? null : row.id));
                          }}
                        >
                          {primaryRepoId === row.id ? '取消主仓库' : '设为主仓库'}
                        </button>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <button
                        type="button"
                        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-sm px-2 text-meta text-secondary hover:text-primary disabled:opacity-40 md:min-h-0 md:min-w-0 md:px-0"
                        data-testid="repo-check"
                        aria-label={`检查仓库 ${index + 1}`}
                        title="在这台机器上试着读一下；不保存、不创建、不 clone"
                        disabled={rowProblem !== null || rowChecking || checking || save.isPending}
                        onClick={() => checkRow(index)}
                      >
                        {rowChecking ? '检查中…' : '检查'}
                      </button>
                      <button
                        type="button"
                        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-sm px-2 text-meta text-tertiary hover:text-rust disabled:opacity-40 md:min-h-0 md:min-w-0 md:px-0"
                        data-testid="repo-remove"
                        title="从清单里删掉这个仓库"
                        onClick={() => {
                          if (primaryRepoId !== null && primaryRepoId === row.id) setPrimaryRepoId(null);
                          remove(index);
                        }}
                      >
                        删除
                      </button>
                    </span>
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
                        onChange={(event) => update(index, repoUrlPatch(row, event.target.value))}
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
                  {/* 令牌单独占一行：地址框在窄屏（369px）已经够挤，别再来抢宽度 */}
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <label className="block min-w-0 flex-1 text-meta text-secondary">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        访问令牌
                        <span className="text-tertiary">可选</span>
                      </span>
                      <input
                        className={`${INPUT} mt-0.5 w-full`}
                        data-testid="repo-token"
                        type="password"
                        autoComplete="off"
                        maxLength={REPO_TOKEN_MAX}
                        aria-label="仓库访问令牌"
                        placeholder={row.hasToken ? '已配置；留空不改' : '私有仓库的 access token'}
                        value={row.credential}
                        onChange={(event) => update(index, { credential: event.target.value, clearToken: false })}
                      />
                    </label>
                    {row.hasToken || row.clearToken ? (
                      <button
                        type="button"
                        className={`shrink-0 text-meta hover:text-rust ${row.clearToken ? 'text-secondary' : 'text-tertiary'}`}
                        data-testid="repo-token-clear"
                        title={row.clearToken ? '撤销清除，保留已有令牌' : '保存后清掉这行的令牌'}
                        onClick={() => update(index, clearCredential(row))}
                      >
                        {row.clearToken ? '撤销清除' : '清除'}
                      </button>
                    ) : null}
                  </div>
                  {row.clearToken ? (
                    <p className="mt-1 text-meta text-tertiary" data-testid="repo-token-cleared">
                      保存后会清掉这行的令牌。
                    </p>
                  ) : null}
                  {rowProblem !== null ? <p className="mt-1 text-meta text-rust">{rowProblem}</p> : null}
                  <RepoProbeStatus probe={probe} testId="repo-check-result" />
                </div>
              );
            })}
          </div>

          {rows.length > 0 ? (
            <p className="mt-2 text-meta text-tertiary" data-testid="repo-token-hint">
              令牌只用于 https:// 私有仓库（GitLab / Gitea 的 access token 即可）；SSH 地址不用填，用机器上的 key。
            </p>
          ) : null}

          <p
            className={`text-meta text-rust ${checkSummary === null ? '' : 'mt-2'}`}
            aria-live="polite"
            data-testid="repo-check-summary"
          >
            {checkSummary ?? ''}
          </p>

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
              <SaveStatus dirty={dirty} saved={save.isSuccess} />
              {checkSummary !== null ? (
                <button type="button" className={SECONDARY_BUTTON} data-testid="repo-check-force" onClick={forceSave}>
                  仍然保存
                </button>
              ) : null}
              <button
                type="button"
                className={SECONDARY_BUTTON}
                data-testid="repos-save"
                disabled={!dirty || problem !== null || save.isPending || checking}
                onClick={() => void checkThenSave()}
              >
                {checking ? '检查中…' : save.isPending ? '保存中…' : '保存仓库'}
              </button>
            </div>
          </div>
          {skipped !== null && save.isSuccess ? (
            <p className="mt-1 text-meta text-tertiary" data-testid="repo-check-skipped">
              {skipped}
            </p>
          ) : null}
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
    return <p className="text-meta text-tertiary" data-testid="project-repos-readonly">还没有仓库。</p>;
  }
  return (
    <ul className="space-y-1 text-meta text-secondary" data-testid="project-repos-readonly">
      {rows.map((row, index) => (
        <li key={row.id === '' ? `repo-${index}` : row.id} className="flex flex-wrap items-baseline gap-x-2">
          {index === 0 ? <span className="rounded-sm border border-hair px-1.5 py-0.5 text-meta text-tertiary">主仓库</span> : null}
          <span className="text-primary">{row.name}</span>
          <span className="break-all text-tertiary">{row.url}</span>
          <span className="text-tertiary">{row.defaultBranch === '' ? 'main' : row.defaultBranch}</span>
          {row.hasToken ? <span className="text-tertiary">有令牌</span> : null}
        </li>
      ))}
      <li className="text-tertiary">只有项目主人 / 管理员能改这块。</li>
    </ul>
  );
}
