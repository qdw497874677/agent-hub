import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, RequestFailed, type FilesContextMemberDto } from '../../shell/api.ts';
import type { AddableRepo, RepoAddNotice } from './repo-switcher.tsx';
import type { WorkspaceGroupView } from './workspace-group.ts';

/**
 * 加仓库这一下的结论。`kind` 决定颜色和有没有动作：
 * - ok：服务端确认（同一个组 + 这个 repoId + ready）；
 * - error：权威读确认这个 repoId 真的不在组里，可以给人手动重试；
 * - muted：结论没定（读也没读成 / 同名冲突 / 进去了但没就绪），只给只读的重新确认。
 */
interface AddRepoAttempt {
  readonly repoId: string;
  readonly repoName: string;
  readonly kind: 'ok' | 'error' | 'muted';
  readonly text: string;
  readonly retry: boolean;
  readonly recheck: boolean;
}

/**
 * 服务端给的那句话不进界面：里面可能带机器路径、git stderr。只按错误码给一句人话。
 * （组合工作目录这几个码目前就是这几件事：组没了 / 已经在组里 / 参数或机器不支持 / 没权限 / 机器不可用。）
 */
export function addRepoFailureText(failure: unknown): string {
  if (!(failure instanceof RequestFailed)) return '请求没有完成';
  switch (failure.detail.code) {
    case 'not_found':
      return '组合工作目录已经不在了';
    case 'conflict':
      return '这个仓库已经在组合工作目录里了';
    case 'forbidden':
      return '没有权限加这个仓库';
    case 'unavailable':
      return '机器暂时不可用';
    case 'invalid':
      return '这台机器现在加不了这个仓库';
    default:
      return failure.status >= 500 ? '机器那边没有完成这次操作' : '请求没有完成';
  }
}

export interface UseAddRepositoryInput {
  readonly sessionId: string;
  /** 组合工作目录的会话才有；null 时根本没有「加仓库」这回事。 */
  readonly groupId: string | null;
  readonly projectId: string;
  readonly repos: readonly AddableRepo[];
  /** 组合工作目录现有的成员（会话上下文那一份，不是结论的依据）。 */
  readonly members: readonly FilesContextMemberDto[];
}

/**
 * 加仓库的动作与结论：短名单、请求去重、权威读重新确认、换会话丢弃旧结果。
 * 界面怎么摆（RepoSwitcher / 抽屉 / 状态行）留给调用方；这里只管状态和语义。
 */
export function useAddRepository({ sessionId, groupId, projectId, repos, members }: UseAddRepositoryInput) {
  const queries = useQueryClient();
  const [addingRepo, setAddingRepo] = useState<string | null>(null);
  // 同一 tick 内连点两下时 state 还没刷新，用 ref 抢先挡住第二次请求：后端没有幂等键。
  const addingRepoRef = useRef<string | null>(null);
  // 每个仓库这一轮的结论各自留档（抽屉 / 状态行原地显示）：失败不弹全局 toast，也不悄悄吞掉。
  // 用 map 而不是单个槽位——否则加下一个仓库会把上一个还没定的结论顶掉，那个仓库就又回到短名单里了。
  const [addRepoAttempts, setAddRepoAttempts] = useState<Record<string, AddRepoAttempt>>({});
  // 每次「加仓库 / 重新确认」都有个序号，换会话也 +1：A→B→A 之后才回来的旧结果不能落在页面上。
  const opSeqRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
    opSeqRef.current += 1;
    addingRepoRef.current = null;
    setAddingRepo(null);
    setAddRepoAttempts({});
  }, [sessionId]);
  /**
   * 只有组合工作目录的会话才谈得上加仓库：groupId 是唯一依据。
   * 以前按「项目里还有仓库不在 members 里」判断，而单仓会话的 members 恒为空，
   * 于是每条会话都长出「添加仓库」，点下去却被 `groupId === null` 静默吞掉。
   */
  const baseAddable = groupId === null ? [] : repos.filter(
    (item) => !members.some((member) => (member.repoId === undefined ? member.name === item.name : member.repoId === item.id))
  );
  /**
   * 已经有过一次结论的仓库不再出现在候选短名单里：结论没定（读不成 / 同名）时它只能走
   * 「重新确认」，确认没加上才给「重试」。否则人可以在短名单里把这个仓库原样再发一次——
   * 后端没有幂等键，那就是多建一个工作目录的路。
   */
  const attemptFor = (repoId: string) => addRepoAttempts[repoId];
  const addable = baseAddable.filter((item) => attemptFor(item.id) === undefined);
  /**
   * 用权威 GET 再读一遍这个组：只有它明确说「没有这个 repoId」才允许人手动重试。
   * 读不成、读到的不是这个组、或组里已有同名仓库时都不给重试——后端没有幂等键，
   * 多打一次就可能多建一个工作目录。成员的 failed / preparing 如实说，不冒充 ready。
   */
  const reconcileAdd = async (
    targetGroupId: string,
    repoId: string,
    repoName: string,
    absentReason: string,
    readyText: string
  ): Promise<AddRepoAttempt> => {
    const unconfirmed = (reason: string): AddRepoAttempt => ({
      repoId,
      repoName,
      kind: 'muted',
      text: `没有确认「${repoName}」加进来（${absentReason}）：${reason}`,
      retry: false,
      recheck: true
    });
    let group: WorkspaceGroupView;
    try {
      group = await api.workspaceGroup(targetGroupId);
    } catch {
      return unconfirmed('再读一次也没读成');
    }
    if (group.id !== targetGroupId) return unconfirmed('读到的不是这个组合工作目录');
    const member = group.members.find((item) => item.repoId === repoId) ?? null;
    if (member !== null) {
      if (member.state === 'ready') return { repoId, repoName, kind: 'ok', text: readyText, retry: false, recheck: false };
      if (member.state === 'failed') {
        return { repoId, repoName, kind: 'muted', text: `「${repoName}」加进来了，但准备失败：仓库列表里那条显示为「失败」`, retry: false, recheck: false };
      }
      return { repoId, repoName, kind: 'muted', text: `「${repoName}」加进来了，还在准备：稍后会出现在仓库列表里`, retry: false, recheck: false };
    }
    if (group.members.some((item) => item.name === repoName)) {
      return {
        repoId,
        repoName,
        kind: 'muted',
        text: `没有加上「${repoName}」：组里已经有一个同名仓库，先不要再发一次`,
        retry: false,
        recheck: true
      };
    }
    return { repoId, repoName, kind: 'error', text: `没有加上「${repoName}」：${absentReason}`, retry: true, recheck: false };
  };
  /**
   * 成员页签 / 工作目录列表靠这两个查询，结论不靠它们（上面那次 GET 才是权威读），
   * 所以这里发完就完，不 await：await 会把可能吞掉的 refetch 错误当成结论。
   */
  const refreshRepoQueries = (forSession: string, targetGroupId: string) => {
    void Promise.all([
      queries.invalidateQueries({ queryKey: ['files', forSession, 'combo-context'] }),
      queries.invalidateQueries({ queryKey: ['workspace-group', targetGroupId] }),
      queries.invalidateQueries({ queryKey: ['workspaces', projectId] }),
      queries.invalidateQueries({ queryKey: ['canvas', projectId] })
    ]);
  };
  const addRepo = async (repoId: string, fromRetry = false) => {
    // 渲染是一回事，发请求是另一回事：这里再守一道，任何路径都不会发出无主的请求。
    if (groupId === null || addingRepoRef.current !== null) return;
    const prior = attemptFor(repoId);
    // 短名单只放没有结论的仓库。要再发同一个仓库，唯一入口是「重试」，
    // 而「重试」只出现在权威读确认它确实不在组里之后（prior.retry），且它那时还得真能加。
    if (fromRetry
      ? prior === undefined || !prior.retry || !baseAddable.some((item) => item.id === repoId)
      : prior !== undefined) return;
    const targetGroupId = groupId;
    const repoName = repos.find((item) => item.id === repoId)?.name ?? '这个仓库';
    const forSession = sessionId;
    const opId = ++opSeqRef.current;
    const current = () => opSeqRef.current === opId && sessionIdRef.current === forSession;
    addingRepoRef.current = repoId;
    setAddingRepo(repoId);
    // 上一次「已加上」的结论开始下一次动作时就收起来：它是确认，不是常驻提示。
    setAddRepoAttempts((prev) => Object.fromEntries(Object.entries(prev).filter(([, item]) => item.kind !== 'ok')));
    let attempt: AddRepoAttempt | null = null;
    try {
      const made = await api.addWorkspaceGroupMember(targetGroupId, { repoId });
      if (!current()) return;
      // 只认「同一个组 + 这个 repoId + ready」：别的组的回包、只有同名仓库、preparing 都不算成功。
      const member = made.id === targetGroupId ? made.members.find((item) => item.repoId === repoId) ?? null : null;
      if (member !== null && member.state === 'ready') {
        attempt = { repoId, repoName, kind: 'ok', text: `已把「${repoName}」加进组合工作目录`, retry: false, recheck: false };
      } else if (member !== null && member.state === 'failed') {
        attempt = { repoId, repoName, kind: 'muted', text: `「${repoName}」加进来了，但准备失败：仓库列表里那条显示为「失败」`, retry: false, recheck: false };
      } else if (member !== null) {
        attempt = { repoId, repoName, kind: 'muted', text: `「${repoName}」加进来了，还在准备：稍后会出现在仓库列表里`, retry: false, recheck: false };
      } else {
        attempt = await reconcileAdd(
          targetGroupId,
          repoId,
          repoName,
          made.id !== targetGroupId ? '服务端回的组对不上' : '服务端没有返回这个仓库',
          `已把「${repoName}」加进组合工作目录`
        );
      }
    } catch (failure) {
      if (!current()) return;
      // 后端没有幂等键，且可能已经写了工作目录却没登记：先读一次真状态，绝不自动重发。
      const conflict = failure instanceof RequestFailed && failure.detail.code === 'conflict';
      attempt = await reconcileAdd(
        targetGroupId,
        repoId,
        repoName,
        addRepoFailureText(failure),
        conflict ? `「${repoName}」已经在组合工作目录里了` : `已把「${repoName}」加进组合工作目录`
      );
    } finally {
      if (current()) {
        addingRepoRef.current = null;
        setAddingRepo(null);
      }
    }
    if (attempt === null || !current()) return;
    setAddRepoAttempts((prev) => ({ ...prev, [attempt.repoId]: attempt }));
    refreshRepoQueries(forSession, targetGroupId);
  };
  /** 只读的「再读一次」：结论没定时唯一的动作；读到确实不在组里才会长出「重试」。 */
  const recheckAdd = async (repoId: string) => {
    if (groupId === null || addingRepoRef.current !== null) return;
    // 只对已经有结论的仓库做重新确认：没加过的仓库不该借这条路径发请求。
    if (attemptFor(repoId) === undefined) return;
    const targetGroupId = groupId;
    const repoName = repos.find((item) => item.id === repoId)?.name ?? '这个仓库';
    const forSession = sessionId;
    const opId = ++opSeqRef.current;
    const current = () => opSeqRef.current === opId && sessionIdRef.current === forSession;
    addingRepoRef.current = repoId;
    setAddingRepo(repoId);
    setAddRepoAttempts((prev) => Object.fromEntries(Object.entries(prev).filter(([, item]) => item.kind !== 'ok')));
    let attempt: AddRepoAttempt | null = null;
    try {
      attempt = await reconcileAdd(targetGroupId, repoId, repoName, '组里还是没有这个仓库', `「${repoName}」已经在组合工作目录里了`);
    } finally {
      if (current()) {
        addingRepoRef.current = null;
        setAddingRepo(null);
      }
    }
    if (attempt === null || !current()) return;
    setAddRepoAttempts((prev) => ({ ...prev, [attempt.repoId]: attempt }));
    refreshRepoQueries(forSession, targetGroupId);
  };
  /**
   * 把结论交给界面时再定一次性：成员列表里已经出现这个 repoId（别的标签页刚加过、
   * 或者上一次的旧结论）就不再重复说一句；重试只在仓库仍可加、且这次是「权威读说它确实不在」时才给。
   * 每个仓库各自一条：另一个仓库的结论不会把这一条顶掉，它的短名单入口也就不会偷偷回来。
   */
  const notices: RepoAddNotice[] = Object.values(addRepoAttempts).flatMap((attempt) => {
    const confirmed = members.some((member) => (member.repoId === undefined ? member.name === attempt.repoName : member.repoId === attempt.repoId));
    if (attempt.kind === 'error' && confirmed) return [];
    return [{
      repoId: attempt.repoId,
      kind: attempt.kind,
      text: attempt.text,
      ...(attempt.retry && !confirmed && baseAddable.some((item) => item.id === attempt.repoId) ? { retryRepoId: attempt.repoId } : {}),
      ...(attempt.recheck ? { recheckRepoId: attempt.repoId } : {})
    }];
  });
  /**
   * 单仓会话不再假装能加仓库，但要说清楚为什么：用户刚在这里点过「添加仓库」，入口不能凭空消失。
   * 判据用会话自带的 groupId（一进页面就知道），不用还没解析出来的 isCombo——
   * 否则组合会话加载中的一瞬间会闪一句「这里不能加」。只有项目里真有别的仓库时才解释。
   */
  const repoHint = groupId === null && repos.length > 1
    ? '加仓库只对组合工作目录有效；要多仓库协作，在任务里新开会话时选「新建组合工作目录」。'
    : null;
  return { addingRepo, addable, notices, addRepo, recheckAdd, repoHint };
}
