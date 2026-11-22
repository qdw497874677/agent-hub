import type { DelegationDto, DelegationPublishDto, DelegationState } from './delegation-types.ts';

/**
 * 派工界面的纯逻辑：状态文案、提交号展示、批准键的稳定性、仓库匹配。
 *
 * 这里不放 React，也不碰网络：浏览器用例和单测都能直接调。
 */

export const DELEGATION_STATE_LABEL: Readonly<Record<DelegationState, string>> = {
  pending: '等待开始',
  preparing: '正在建独立目录',
  prepared: '已就绪',
  failed: '失败',
  uncertain: '结果不明',
  cancelled: '已取消'
};

/** 状态色调：和项目里其它徽标同一套语义（ok / warn / danger / 中性）。 */
export type DelegationTone = 'ok' | 'warn' | 'danger' | 'idle';

export function delegationTone(state: DelegationState): DelegationTone {
  switch (state) {
    case 'prepared':
      return 'ok';
    case 'pending':
    case 'preparing':
      return 'warn';
    case 'failed':
    case 'uncertain':
      return 'danger';
    case 'cancelled':
      return 'idle';
  }
}

/** `uncertain` 不是「失败可重试」：只能对账，不能再自动跑一遍。 */
export function delegationNeedsReconcile(state: DelegationState): boolean {
  return state === 'uncertain';
}

/**
 * 能不能点「确认开始」。
 * 只看服务端的 `canConfirm`：pending 里还有「等 Runtime 提议」的那一类，不能一律当可确认。
 */
export function delegationCanConfirm(record: Pick<DelegationDto, 'state' | 'canConfirm'>): boolean {
  return record.state === 'pending' && record.canConfirm === true;
}

/** 一行状态说明：把「等人确认」和「等 Runtime 提议」分开说。 */
export function delegationStatusLine(record: Pick<DelegationDto, 'state' | 'canConfirm' | 'failure'>): string {
  if (record.state === 'pending') {
    return record.canConfirm === true ? '等你确认就开始建独立目录' : '等待 Runtime 提议，提议到了才能确认';
  }
  if (record.state === 'preparing') return '正在建独立目录、拉取基线';
  if (record.state === 'prepared') return '目录已就绪，可以进执行会话';
  if (record.state === 'failed') return record.failure?.message.trim() || '失败了';
  if (record.state === 'uncertain') return record.failure?.message.trim() || '结果不明：先对账，别重复发起';
  return '已取消';
}

/** 提议 / 派工里人写的那部分配置：agent、模型、启动预设。 */
export function delegationStartupLabel(
  startup: { readonly agentId: string; readonly model: string | null; readonly profileId: string | null } | null | undefined
): string {
  if (!startup) return '未指定执行配置';
  const model = startup.model?.trim() || '默认模型';
  return startup.profileId ? `${startup.agentId} · ${model} · 预设 ${startup.profileId}` : `${startup.agentId} · ${model}`;
}

/** 40 位提交号截短给人看，完整值另放在可选中/可复制的行里。 */
export function shortSha(sha: string | null | undefined): string {
  const value = (sha ?? '').trim();
  return value === '' ? '—' : value.slice(0, 7);
}

export function isSha(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/**
 * 批准键按「哪条派工 + 哪个提交」固定：
 * - 同一个提交重试（网络抖动、双击、刷新后重试）必须原样复用；
 * - 执行会话又提交了新改动（提交号变了）就是一次新的批准，换新键，
 *   否则服务端会按「同键不同内容」判冲突。
 */
export interface ApprovalMemory {
  readonly delegationId: string;
  readonly headSha: string;
  readonly approvalKey: string;
}

export function approvalStorageKey(delegationId: string): string {
  return `agent-hub:delegation-approval:${delegationId}`;
}

export function readApprovalMemory(raw: string | null): ApprovalMemory | null {
  if (raw === null || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ApprovalMemory> | null;
    if (
      parsed === null ||
      typeof parsed.delegationId !== 'string' ||
      typeof parsed.headSha !== 'string' ||
      typeof parsed.approvalKey !== 'string' ||
      parsed.delegationId.trim() === '' ||
      parsed.approvalKey.trim() === ''
    ) {
      return null;
    }
    return { delegationId: parsed.delegationId, headSha: parsed.headSha, approvalKey: parsed.approvalKey };
  } catch {
    return null;
  }
}

/**
 * 这次批准该用哪个键：同提交复用旧键，换提交（或没有记录）就用 `fresh()` 生成的新键。
 * 返回 true 表示需要写回存储。
 */
export function chooseApprovalKey(
  delegationId: string,
  headSha: string,
  stored: ApprovalMemory | null,
  fresh: () => string
): { readonly memory: ApprovalMemory; readonly changed: boolean } {
  if (stored && stored.delegationId === delegationId && stored.headSha === headSha && stored.approvalKey.trim() !== '') {
    return { memory: stored, changed: false };
  }
  return { memory: { delegationId, headSha, approvalKey: fresh() }, changed: true };
}

/** 派工只在「派工自己的目录」里执行：临时 worktree，带功能分支。 */
export function delegationBranchLabel(record: Pick<DelegationDto, 'branch'>): string {
  return record.branch.trim() === '' ? '（无分支）' : record.branch;
}

/** 主会话的工作空间必须是这个项目仓库：按 HTTPS 规范地址粗匹配，最终以服务端校验为准。 */
export function canonicalRepoUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

export function matchRepoForWorkspace<T extends { readonly url: string }>(
  repos: readonly T[],
  workspaceRepoUrl: string | null | undefined
): T | null {
  if (!workspaceRepoUrl) return null;
  const wanted = canonicalRepoUrl(workspaceRepoUrl);
  return repos.find((repo) => canonicalRepoUrl(repo.url) === wanted) ?? null;
}

/** 发布面板能不能点「推送并开草稿 PR」。 */
export type PublishGate =
  | { readonly kind: 'ready'; readonly headSha: string }
  | { readonly kind: 'blocked'; readonly reason: string };

export function publishGate(view: DelegationPublishDto): PublishGate {
  const attempt = view.attempt;
  if (attempt !== null && attempt.state === 'published') return { kind: 'blocked', reason: '这条派工的草稿 PR 已经建好' };
  if (attempt !== null && attempt.state === 'publishing') return { kind: 'blocked', reason: '上一次发布还没落定：先对账，不要重复发' };
  if (attempt !== null && attempt.state === 'uncertain') return { kind: 'blocked', reason: '上一次发布结果不明：先对账，不要重复发' };
  if (view.state !== 'prepared') {
    return { kind: 'blocked', reason: `派工还没就绪（${DELEGATION_STATE_LABEL[view.state]}），没有可批准的提交` };
  }
  if (view.repo === null) return { kind: 'blocked', reason: '这条派工的仓库地址解析不出来，发布不了' };
  if (!isSha(view.headSha)) {
    return { kind: 'blocked', reason: view.headUnavailable?.trim() || '拿不到工作区当前提交，先刷新再试' };
  }
  return { kind: 'ready', headSha: view.headSha };
}

/** 发布结果一句话：只描述服务端核对过的事实，不夸大成「已合并」。 */
export function publishOutcomeLine(view: DelegationPublishDto): string {
  const attempt = view.attempt;
  if (attempt === null) return '还没有发布过';
  if (attempt.state === 'published') {
    const pr = attempt.pullRequest;
    return pr === null ? '远端已核对：分支已推送' : `草稿 PR #${pr.number} 已创建：${pr.repo}`;
  }
  if (attempt.state === 'publishing') return '正在推送 / 建 PR';
  if (attempt.state === 'uncertain') return '结果不明：推送或 PR 是否已发生无法确认，请对账';
  return attempt.failure?.message.trim() || '发布失败，可以核对后重试';
}

/** 列表行的摘要：任务、基线、分支，缺哪个说哪个。 */
export function delegationSummary(record: DelegationDto, taskTitle: string | null): string {
  const task = taskTitle ?? '未知任务';
  const base = record.baseBranch.trim() === '' ? '未知基线' : record.baseBranch;
  return `${task} · 基线 ${base} · ${delegationBranchLabel(record)}`;
}
