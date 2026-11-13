/**
 * worktree 的产品层逻辑（docs/design/worktree.md §3 §4 §7）：项目级档位 / 准备命令 / 超时，
 * 以及会话页那一行准备状态。纯函数，不碰 DOM，方便单测——所以这里只从契约取类型，
 * 不碰 shell/api.ts（它带 DOM 与不可擦除语法，根 tsconfig 编不了）。
 *
 * 字段形状直接来自契约（ProjectDto.worktree / WorkspaceDto.setup），但读取仍然防御：
 * 库里可能存着这个字段落地之前的老行，界面见到「没配」而不是崩。
 */
import type { ProjectDto, WorkspaceDto } from '@agent-hub/contract';

/** 准备命令超时：默认 10 分钟，和后端一致。 */
export const WORKTREE_TIMEOUT_DEFAULT = 600;
export const WORKTREE_TIMEOUT_MIN = 30;
export const WORKTREE_TIMEOUT_MAX = 1800;
/** 准备命令最长 4000 字符：够写 `npm ci && npm run db:migrate`，又不至于把配置页当脚本仓库。 */
export const SETUP_COMMAND_MAX = 4000;

/** 新任务默认档位 + 建好 worktree 后要跑的准备命令（Project.worktree）。形状直接取契约。 */
export type ProjectWorktreeConfig = NonNullable<ProjectDto['worktree']>;

export type WorktreeSetupConfig = NonNullable<ProjectWorktreeConfig['setup']>;

/** 某个工作空间这一刻的准备状态（Workspace.setup），形状直接取契约。 */
export type WorkspaceSetup = NonNullable<WorkspaceDto['setup']>;

/** 设置页手里的编辑草稿：超时留 string，让人可以清空重打，而不是被 number 输入框吞成 0。 */
export type WorktreeDraft = {
  readonly mode: 'shared' | 'isolated';
  readonly command: string;
  readonly waitForSetup: boolean;
  readonly timeout: string;
};

export type WorktreePatch = { worktree: NonNullable<ProjectDto['worktree']> };

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const timeOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const timeoutOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= WORKTREE_TIMEOUT_MIN && value <= WORKTREE_TIMEOUT_MAX
    ? value
    : fallback;

/** 从项目（或任意 JSON）里读 worktree 配置；没配 / 老数据返回 null。 */
export function projectWorktree(project: unknown): ProjectWorktreeConfig | null {
  const raw = record(record(project)?.worktree);
  if (raw === null) return null;
  const mode = raw.mode === 'isolated' ? 'isolated' : 'shared';
  const setupRaw = record(raw.setup);
  const command = textOrNull(setupRaw?.command) ?? '';
  // 命令为空等价于「不准备」：后端存了空串也按 null 读，别让界面显示一个空脚本。
  if (setupRaw === null || command.trim() === '') return { mode, setup: null };
  return {
    mode,
    setup: {
      command,
      waitForSetup: setupRaw.waitForSetup === true,
      timeoutSeconds: timeoutOr(setupRaw.timeoutSeconds, WORKTREE_TIMEOUT_DEFAULT)
    }
  };
}

/** 从工作空间（或任意 JSON）里读准备状态；没有 setup 字段返回 null。 */
export function workspaceSetup(workspace: unknown): WorkspaceSetup | null {
  const raw = record(record(workspace)?.setup);
  if (raw === null) return null;
  const state =
    raw.state === 'running' || raw.state === 'ready' || raw.state === 'failed' ? raw.state : 'none';
  return {
    state,
    exitCode: typeof raw.exitCode === 'number' && Number.isInteger(raw.exitCode) ? raw.exitCode : null,
    message: textOrNull(raw.message),
    output: textOrNull(raw.output),
    startedAt: timeOrNull(raw.startedAt),
    finishedAt: timeOrNull(raw.finishedAt)
  };
}

/** 项目当前配置 → 设置页草稿。 */
export function worktreeDraft(project: unknown): WorktreeDraft {
  const config = projectWorktree(project);
  return {
    mode: config?.mode ?? 'shared',
    command: config?.setup?.command ?? '',
    waitForSetup: config?.setup?.waitForSetup ?? false,
    timeout: String(config?.setup?.timeoutSeconds ?? WORKTREE_TIMEOUT_DEFAULT)
  };
}

/** 就地校验；null = 可以保存。错误文案直接给用户看，别只标红。 */
export function worktreeDraftProblem(draft: WorktreeDraft): string | null {
  const command = draft.command.trim();
  if (command === '') {
    return draft.waitForSetup ? '开了「等待准备完成」但还没写命令；要么写一条，要么把等待关掉。' : null;
  }
  if (draft.command.length > SETUP_COMMAND_MAX) {
    return `准备命令太长了（${draft.command.length} 字符），最多 ${SETUP_COMMAND_MAX}。`;
  }
  const seconds = Number(draft.timeout.trim());
  if (draft.timeout.trim() === '' || !Number.isInteger(seconds)) {
    return `超时得是整数秒（${WORKTREE_TIMEOUT_MIN}–${WORKTREE_TIMEOUT_MAX}）。`;
  }
  if (seconds < WORKTREE_TIMEOUT_MIN || seconds > WORKTREE_TIMEOUT_MAX) {
    return `超时得在 ${WORKTREE_TIMEOUT_MIN}–${WORKTREE_TIMEOUT_MAX} 秒之间，现在是 ${seconds}。`;
  }
  return null;
}

/** 草稿 → PATCH body。命令为空时 setup: null（= 不准备），超时非法时回默认值兜底。 */
export function worktreePayload(draft: WorktreeDraft): WorktreePatch {
  const command = draft.command.trim();
  const seconds = Number(draft.timeout.trim());
  const timeoutSeconds =
    Number.isInteger(seconds) && seconds >= WORKTREE_TIMEOUT_MIN && seconds <= WORKTREE_TIMEOUT_MAX
      ? seconds
      : WORKTREE_TIMEOUT_DEFAULT;
  return {
    worktree: {
      mode: draft.mode,
      setup: command === '' ? null : { command, waitForSetup: draft.waitForSetup, timeoutSeconds }
    }
  };
}

export interface SetupStatusLine {
  readonly tone: 'idle' | 'busy' | 'ok' | 'bad';
  readonly text: string;
}

/** 会话页标题区那一行：null = 没什么可说的（没准备过，或准备好了但没有日志要展示）。 */
export function setupStatusLine(setup: WorkspaceSetup | null): SetupStatusLine | null {
  if (setup === null || setup.state === 'none') return null;
  if (setup.state === 'running') return { tone: 'busy', text: '正在准备 worktree…' };
  if (setup.state === 'failed') {
    const detail =
      setup.message?.trim() ||
      (setup.exitCode !== null ? `退出码 ${setup.exitCode}` : '命令没有跑完');
    return { tone: 'bad', text: `准备失败：${detail}` };
  }
  // ready：只有留了输出才值得占一行（同时把日志折叠挂在旁边）；没有输出就是安静的完成。
  return (setup.output ?? '').trim() === '' ? null : { tone: 'ok', text: '准备完成' };
}

/** 展示用：输出只给最后 8KB，和 worker 侧保留的上限一致。 */
export function setupOutputTail(output: string | null, limit = 8192): string {
  if (output === null) return '';
  return output.length > limit ? output.slice(output.length - limit) : output;
}
