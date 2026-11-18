import type { Subject } from '../access.ts';
import { forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import type { SessionId } from '../ids.ts';
import type { ToolContext, ToolDescriptor, ToolProvider } from '../ports/tool-provider.ts';
import { err, ok, type Result } from '../result.ts';
import type { GitAction, GitRunInput, GitWorkflowService } from '../use-cases/git-workflow.ts';

/**
 * git.*（issue #216 / docs/design/agent-git-tools.md §4）：把 hub 已有的 git 工作流交给 agent。
 *
 * 为什么不让 agent shell 出去跑 git/gh：那样会绕开 `git.push` 权限（access.ts）、
 * `git.commit` / `git.push` / `git.pr` 审计，以及 PR 落库后的 `task_pull_requests` 回填。
 *
 * 工具只有 ToolGrant，没有 principal；权限主体由装配层注入 `subjectOf`（会话 owner /
 * bot 背后的账号）。scope='git' 只决定「这条会话能不能看到这些工具」，
 * 真正的写入权限仍由工作流里的 `git.push` 与项目 / 工作流判定。
 */
export const GIT_MESSAGE_MAX = 2_000;
export const GIT_PR_TITLE_MAX = 200;
export const GIT_PR_BODY_MAX = 8_000;

/** 只需要工作流里的三个入口；测试可以拿假实现顶上。 */
export type GitWorkflow = Pick<GitWorkflowService, 'state' | 'run' | 'listForTask'>;

export interface GitToolDeps {
  readonly workflow: GitWorkflow;
  /** 会话的权限主体；null = 找不到人（工作流按匿名拒绝，不在这里崩）。 */
  readonly subjectOf: (sessionId: SessionId) => Promise<Subject | null>;
  /** 会话通信 P1c：git.state 的 session 参数（看已连线同伴的 git 状态，只读）。 */
  readonly resolvePeer?: (fromSessionId: SessionId, address: string) => Promise<Result<SessionId, DomainError>>;
}

const COMMON = 'Do not run git or gh through the shell: commit/push/PR must go through this backend so the project git.push permission and the audit trail apply.';
const WORKSPACE = { type: 'string', minLength: 1, maxLength: 200, description: 'Member workspace id, only for a multi-repo workspace; omit when the session has a single repo.' };

export const GIT_TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'git.state',
    version: 1,
    scope: 'git',
    perMinute: 10,
    description: `Show the session workspace git state: isGit, branch, default branch, origin/GitHub repo, changed files, ahead count, upstream, whether you may push, why a PR is blocked, how PRs would be opened, and the task's pull requests. Pass session ("peer:<handle>" or "session:<id>") to read a linked peer's state instead of your own (read-only). ${COMMON}`,
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        session: { type: 'string', minLength: 3, maxLength: 200, description: 'Optional linked peer to inspect: "peer:<handle>" or "session:<id>". Omit for your own session.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'git.commit',
    version: 1,
    scope: 'git',
    perMinute: 10,
    description: `Commit the current workspace changes with the given message (nothing is pushed). ${COMMON}`,
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, maxLength: GIT_MESSAGE_MAX },
        workspace: WORKSPACE
      },
      required: ['message'],
      additionalProperties: false
    }
  },
  {
    name: 'git.push',
    version: 1,
    scope: 'git',
    perMinute: 10,
    description: `Commit pending changes if any, then push the current branch to origin. Requires the project's git.push permission. ${COMMON}`,
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, maxLength: GIT_MESSAGE_MAX },
        workspace: WORKSPACE
      },
      required: ['message'],
      additionalProperties: false
    }
  },
  {
    name: 'git.pr',
    version: 1,
    scope: 'git',
    perMinute: 10,
    description: `Commit pending changes if any, push the branch, then open a pull request (team GitHub token first, then gh, then a compare link). The created PR is written back to the task, so task.get and git.pull_requests can see it. Requires git.push. ${COMMON}`,
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, maxLength: GIT_MESSAGE_MAX },
        title: { type: 'string', maxLength: GIT_PR_TITLE_MAX },
        body: { type: 'string', maxLength: GIT_PR_BODY_MAX },
        workspace: WORKSPACE
      },
      required: ['message'],
      additionalProperties: false
    }
  },
  {
    name: 'git.pull_requests',
    version: 1,
    scope: 'git',
    perMinute: 10,
    description: `List pull requests opened for the current task (repo, number, url, branch, base, state). ${COMMON}`,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  }
];

const record = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** 允许的字段：schema 只是给模型看的，网关不校验 JSON Schema，所以这里显式拒掉未知字段。 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'git.state': ['workspace', 'session'],
  'git.commit': ['message', 'workspace'],
  'git.push': ['message', 'workspace'],
  'git.pr': ['message', 'title', 'body', 'workspace'],
  'git.pull_requests': []
};

export function createGitToolProvider(deps: GitToolDeps): ToolProvider {
  const optionalWorkspace = (args: Record<string, unknown>): Result<string | undefined, DomainError> => {
    if (args['workspace'] === undefined) return ok(undefined);
    const workspace = str(args['workspace']);
    if (!workspace) return err(invalid('workspace 必须是非空字符串'));
    return ok(workspace);
  };

  return {
    id: 'git',
    tools: () => GIT_TOOLS,
    async call(name, input, ctx: ToolContext): Promise<Result<unknown, DomainError>> {
      const allowed = ALLOWED[name];
      if (!allowed) return err(notFound(`没有这个工具：${name}`));
      const args = record(input);
      const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
      if (unknown.length > 0) return err(invalid(`不认识的参数：${unknown.join(', ')}`));

      const subject = await deps.subjectOf(ctx.grant.sessionId);
      if (name === 'git.pull_requests') {
        // grant 不是 Session，保留 null 判据。
        if (ctx.grant.taskId === null) return err(forbidden('这条会话不属于任何任务，没有任务级的 PR 清单'));
        return deps.workflow.listForTask(subject, ctx.grant.taskId);
      }

      const workspace = optionalWorkspace(args);
      if (!workspace.ok) return workspace;
      if (name === 'git.state') {
        if (args['session'] === undefined) return deps.workflow.state(subject, ctx.grant.sessionId, workspace.value);
        const address = str(args['session']);
        if (!address || !deps.resolvePeer) return err(invalid('session 要写成 peer:<短名> 或 session:<id>'));
        const target = await deps.resolvePeer(ctx.grant.sessionId, address);
        if (!target.ok) return target;
        return deps.workflow.state(subject, target.value, workspace.value);
      }

      const action = name.slice('git.'.length) as GitAction;
      const message = str(args['message']);
      if (!message) return err(invalid('message 必填'));
      if (message.length > GIT_MESSAGE_MAX) return err(invalid(`message 最多 ${GIT_MESSAGE_MAX} 字`));
      const run: { -readonly [K in keyof GitRunInput]: GitRunInput[K] } = { action, message };
      if (args['title'] !== undefined) {
        if (typeof args['title'] !== 'string') return err(invalid('title 必须是字符串'));
        const title = args['title'].trim();
        if (title.length > GIT_PR_TITLE_MAX) return err(invalid(`title 最多 ${GIT_PR_TITLE_MAX} 字`));
        run.title = title;
      }
      if (args['body'] !== undefined) {
        if (typeof args['body'] !== 'string') return err(invalid('body 必须是字符串'));
        if (args['body'].length > GIT_PR_BODY_MAX) return err(invalid(`body 最多 ${GIT_PR_BODY_MAX} 字`));
        run.body = args['body'];
      }
      return deps.workflow.run(subject, ctx.grant.sessionId, run, workspace.value);
    }
  };
}
