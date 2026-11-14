/**
 * 项目设置 · 「代码与空间」页顶那一句状态总结（docs/design/workspaces.md §7）。
 *
 * 纯函数，不碰 DOM，也不 import shell/api.ts —— 根 tsconfig 会编 `apps/web/src/**\/*.test.ts`，
 * 那边没有 DOM 类型。页面只负责把项目 / 空间读成三个数，怎么说话在这里定，方便单测。
 *
 * 这句话要回答的是这一页的三个问题：在几个仓库上干活、目录怎么开、现在有没有空间。
 */

export type WorkspaceMode = 'shared' | 'isolated';

export interface WorkspaceSummaryInput {
  /** 项目绑了几个仓库（ProjectDto.repos.length）。 */
  readonly repos: number;
  /** 新任务的默认档位（ProjectDto.worktree.mode；没配按 shared）。 */
  readonly mode: WorkspaceMode;
  /** 已登记的空间数；不给 = 接口还在读，关于空间的那句先不说。 */
  readonly spaces?: number;
  /** 这些空间分布在几台机器上；只有多于一台时才写出来。 */
  readonly machines?: number;
}

/** 页面靠它决定这句总结是中性的，还是「这里缺一块」的暖色提示。 */
export type WorkspaceSummaryTone = 'info' | 'warn';

/** 数是人给的，也防一手 NaN / 负数：计数类只认正整数。 */
const positive = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** 一句话说清：在几个仓库上干活、目录怎么开、现在有没有空间。 */
export function workspaceSummary(input: WorkspaceSummaryInput): string {
  const repos = positive(input.repos);
  const sentences: string[] = [];
  if (repos === 0) {
    sentences.push('还没绑仓库：现在只能在线关联已有目录，开不了 worktree。');
  } else {
    const work = `在 ${repos} 个仓库上工作`;
    const room = input.mode === 'isolated' ? '每个任务开独立 worktree' : '任务共用长期空间';
    // 多仓库才谈得上「组合工作空间」；共用档是它最主要的用处，独立档只是顺带能选。
    const hint =
      repos > 1
        ? input.mode === 'isolated'
          ? '；派生时可以把几个仓库一起开成组合工作空间'
          : '；需要并行时可在派生时选组合工作空间'
        : '';
    sentences.push(`${work}，${room}${hint}。`);
  }
  if (input.spaces !== undefined) {
    const spaces = positive(input.spaces);
    const machines = positive(input.machines ?? 1);
    if (spaces === 0) sentences.push('这台项目还没有登记空间。');
    else if (machines > 1) sentences.push(`在 ${machines} 台机器上共有 ${spaces} 个空间。`);
    else sentences.push(`现在有 ${spaces} 个空间。`);
  }
  return sentences.join('');
}

/** 没绑仓库是这页唯一「缺一块」的状态，用暖色；其余都是中性陈述。 */
export function workspaceSummaryTone(input: Pick<WorkspaceSummaryInput, 'repos'>): WorkspaceSummaryTone {
  return positive(input.repos) === 0 ? 'warn' : 'info';
}
