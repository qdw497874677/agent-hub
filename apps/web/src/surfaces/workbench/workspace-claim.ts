/**
 * 目录的独占归属（workspaces.md「一个目录只属于一个项目」）：候选列表怎么分组、
 * 为什么这一行不能点「转移」，都定在这里；页面只负责把结果排出来。
 *
 * 纯函数，不碰 DOM，也不 import shell/api.ts —— 根 tsconfig 会编同目录的 *.test.ts，
 * 那边没有 DOM 类型。字段比契约里少，只留分组和按钮真正用到的几个。
 */

/** 认领候选的一行：够了就够，多余字段只会让页面多读一遍。 */
export interface ClaimChoiceView {
  readonly workspaceId: string;
  /**
   * 现在认领它的项目；null = 还没分配。
   * 也可能「有主人但你看不见」——那时 ownerHidden 为 true，别只看这一格。
   */
  readonly ownerProjectId: string | null;
  readonly ownerProjectName: string | null;
  /**
   * 它属于一个你看不见的项目（团队页只给个数，不给名字）：知道有主人，但既转移不了、
   * 也不该显示成「可分配」。
   */
  readonly ownerHidden?: boolean;
}

/** 三档，顺序就是列表里的顺序：能直接用的 → 已经在这里的 → 得先转移的。 */
export interface WorkspaceChoiceGroups {
  /** 可分配：没人认领。 */
  readonly unassigned: readonly ClaimChoiceView[];
  /** 本项目：已经在用（设置页里这些行在上面「已有工作目录」里）。 */
  readonly mine: readonly ClaimChoiceView[];
  /** 别的项目：灰的，只能转移。隐藏主人的那些也算这一档。 */
  readonly others: readonly ClaimChoiceView[];
}

/** 团队页一行里分组用得上的部分（TeamWorkspaceViewDto 的子集）。 */
export interface TeamRowClaimInput {
  readonly workspace: { readonly id: string };
  /** 关联的、你看得见的项目；独占下最多一个。老数据可能不止一个，只认第一个。 */
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  /** 关联了但你看不见的项目数。 */
  readonly hiddenProjects: number;
}

/**
 * 团队页一行 → 候选行。独占下「关联的项目」最多一个，它就是主人；
 * 一个都看不见但有 hiddenProjects 时，记成「有主人但看不见」，不要当成可分配。
 */
export function claimViewFromTeamRow(row: TeamRowClaimInput): ClaimChoiceView {
  const owner = row.projects[0];
  if (owner !== undefined) {
    return { workspaceId: row.workspace.id, ownerProjectId: owner.id, ownerProjectName: owner.name };
  }
  if (row.hiddenProjects > 0) {
    return { workspaceId: row.workspace.id, ownerProjectId: null, ownerProjectName: null, ownerHidden: true };
  }
  return { workspaceId: row.workspace.id, ownerProjectId: null, ownerProjectName: null };
}

/**
 * 分组。保持传入顺序（上层已经按机器 / 时间排过），不在这里二次排序。
 * 隐藏主人的行归「别的项目」：它一定有人认领，只是不知道是谁。
 */
export function groupWorkspaceChoices(
  views: readonly ClaimChoiceView[],
  projectId: string
): WorkspaceChoiceGroups {
  const unassigned: ClaimChoiceView[] = [];
  const mine: ClaimChoiceView[] = [];
  const others: ClaimChoiceView[] = [];
  for (const view of views) {
    if (view.ownerHidden === true) others.push(view);
    else if (view.ownerProjectId === null) unassigned.push(view);
    else if (view.ownerProjectId === projectId) mine.push(view);
    else others.push(view);
  }
  return { unassigned, mine, others };
}

/** 「属于 X」里的 X：认领者没名字时回退成「别的项目」，绝不空着。 */
export function claimOwnerLabel(view: ClaimChoiceView): string {
  if (view.ownerHidden === true) return '你看不到的项目';
  const name = view.ownerProjectName?.trim() ?? '';
  return name === '' ? '别的项目' : name;
}

/**
 * 这一行为什么不能点「转移」；null = 可以点。
 *
 * 只判断前端确切知道的两件事：已经属于本项目（没什么可转的）、主人看不见（拿不到源项目的
 * project.update，后端也一定会拒）。源项目还有会话在跑这类后端才知道的原因，留给请求失败的提示。
 */
export function transferBlockedReason(view: ClaimChoiceView, projectId: string): string | null {
  if (view.ownerHidden === true) {
    return '看不到这个目录现在属于哪个项目，没法在这里转移；让那个项目的人把它转移给你。';
  }
  if (view.ownerProjectId === null) return '这个目录还没分配给项目，直接分配就行。';
  if (view.ownerProjectId === projectId) return '这个目录已经属于本项目。';
  return null;
}
