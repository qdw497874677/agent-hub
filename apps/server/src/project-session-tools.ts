import {
  asSessionId,
  err,
  forbidden,
  invalid,
  notFound,
  ok,
  unavailable,
  type DomainError,
  type GrantActor,
  type Result,
  type SessionId,
  type ToolContext,
  type ToolDescriptor,
  type ToolProvider,
  type ToolScope
} from '@agent-hub/domain';
import { asObject, exactString, hasControl, rejectUnknownKeys, requiredExact } from './project-session-input.ts';

/**
 * 项目会话写工具（docs/design/project-session-mcp.md 实施顺序 1）。
 *
 * 只做两件事：严格解析调用方参数，把**当前工具上下文**里的 actor / 会话绑定交给
 * Hub 侧回调。项目归属、读/写权限、父任务同项目、仓库匹配、请求键幂等与真实副作用
 * 全部由回调实现；这里不从参数、当前目录或资产文本推断身份，也不隐式派工。
 *
 * 两个工具各自使用独立 scope（由装配方注入），默认授权里不出现。
 */

export const PROJECT_TASK_CREATE_TOOL_NAME = 'project.task.create';
export const PROJECT_WORKTREE_START_TOOL_NAME = 'project.worktree.start';
export const PROJECT_CANDIDATE_IMPORT_TOOL_NAME = 'project.candidate.import';
export const PROJECT_SESSION_HANDOFF_TOOL_NAME = 'project.session.handoff';
export const PROJECT_SESSION_LIST_TOOL_NAME = 'project.session.list';

const REQUEST_KEY_MAX = 200;
const ID_MAX = 200;
const TITLE_MAX = 500;
const GOAL_MAX = 20_000;
const INSTRUCTIONS_MAX = 20_000;
const EXECUTION_CONFIG_MAX = 200;
const BODY_MAX = 32_768;
const SHA_LENGTH = 40;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const LIST_DEFAULT = 20;
const LIST_MAX = 50;
const LIST_TITLE_MAX = 200;
const LIST_STATUS_MAX = 40;

/**
 * 写工具各自使用不同的 scope 字符串；装配方传入，不在本文件里签发。
 *
 * 候选导入、同项目交接与只读列表是可选的：不传 scope + 回调时 provider 保持
 * 首版的两条工具不变；传了就必须成对且与其它 scope 互不相同。
 */
export interface ProjectSessionToolScopes {
  readonly taskCreate: ToolScope;
  readonly worktreeStart: ToolScope;
  /** 候选导入：独立的 `project:candidate-import`。 */
  readonly candidateImport?: ToolScope;
  /** 同项目交接：注入 `project:message-send`。 */
  readonly handoff?: ToolScope;
  /** 同项目会话列表：注入 `project:read`。 */
  readonly sessionList?: ToolScope;
}

/** 只来自 `ctx.grant` 的身份与来源会话；不接受 payload 覆盖。 */
export interface ProjectToolBinding {
  readonly actorId: string;
  readonly actorVia: GrantActor['via'];
  readonly sessionId: SessionId;
}

export interface ProjectTaskCreateCommand extends ProjectToolBinding {
  readonly requestKey: string;
  readonly title: string;
  readonly goal: string | null;
  readonly parentTaskId: string | null;
}

export interface ProjectWorktreeStartCommand extends ProjectToolBinding {
  readonly requestKey: string;
  readonly taskId: string;
  readonly repoId: string;
  readonly baseBranch: string;
  readonly instructions: string;
  readonly agentId: string;
  readonly model: string | null;
  readonly profileId: string | null;
}

/**
 * 回调只返回可安全回给模型 / 写进审计的标识快照。
 * 调用方即使多塞了 title / goal / instructions，这里也会按白名单重新组包。
 */
export interface ProjectTaskSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly parentTaskId: string | null;
  readonly status: string;
}

export interface ProjectWorktreeSnapshot {
  readonly delegationId: string;
  readonly executionSessionId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly repoId: string;
  readonly branch: string;
  readonly baseSha: string;
}

/** 候选提交的显式标识：只接受会话 / 仓库 id 与完整 SHA，不接受路径或远端地址。 */
export interface ProjectCandidateRef {
  readonly sourceSessionId: SessionId;
  readonly repoId: string;
  readonly sha: string;
}

export interface ProjectCandidateImportCommand extends ProjectToolBinding {
  readonly requestKey: string;
  readonly sourceSessionId: SessionId;
  readonly targetSessionId: SessionId;
  readonly repoId: string;
  readonly sha: string;
}

/** 只回可核实的导入结果；不携带仓库路径、凭据或提交内容。 */
export interface ProjectCandidateImportSnapshot {
  readonly ref: string;
  readonly sha: string;
  readonly alreadyPresent: boolean;
  readonly targetSessionId: SessionId;
}

export interface ProjectSessionHandoffCommand extends ProjectToolBinding {
  readonly requestKey: string;
  readonly targetSessionId: SessionId;
  readonly body: string;
  /** false = 只进对方收件箱（默认）；true = 排队并尝试唤醒一轮。 */
  readonly wake: boolean;
  /** 只作为交接消息里的候选引用；发消息不等于授权导入。 */
  readonly candidate: ProjectCandidateRef | null;
}

/** 只回消息标识与投递状态；不回正文、目标路径或凭据。 */
export interface ProjectSessionHandoffSnapshot {
  readonly messageId: string;
  readonly targetSessionId: SessionId;
  readonly status: string;
  readonly wake: boolean;
}

export interface ProjectSessionListQuery extends ProjectToolBinding {
  readonly limit: number;
}

/** 列表白名单：足够选择目标，不包含工作区路径、远端、凭据或消息正文。 */
export interface ProjectSessionSummary {
  readonly sessionId: SessionId;
  readonly taskId: string | null;
  readonly title: string | null;
  readonly status: string;
  readonly agentId: string;
}

export interface ProjectSessionListSnapshot {
  readonly sessions: readonly ProjectSessionSummary[];
  readonly truncated: boolean;
}

export interface ProjectSessionToolDeps {
  readonly scopes: ProjectSessionToolScopes;
  /**
   * 创建任务。实现方负责：从绑定里的 session 重新加载会话与账号、核对项目/授权、
   * 校验 parentTaskId 同项目、按 request_key 做幂等。实现方**不得**创建会话或派工。
   */
  readonly createTask: (
    command: ProjectTaskCreateCommand
  ) => Promise<Result<ProjectTaskSnapshot, DomainError>>;
  /**
   * 为已有任务准备 worktree 并启动执行会话。实现方负责：会话/账号/项目与写授权复核、
   * 仓库与 base branch 匹配、请求键幂等、持久化预留与交付。实现方不得接收路径 / URL。
   */
  readonly startWorktree: (
    command: ProjectWorktreeStartCommand
  ) => Promise<Result<ProjectWorktreeSnapshot, DomainError>>;
  /**
   * 可选：把来源会话的完整提交只读导入目标会话仓库的专用引用。实现方负责同项目 /
   * 同仓库 / 同 Worker、读取与使用权限、请求键幂等；不得接收路径、URL 或 Git 参数。
   */
  readonly importCandidate?: (
    command: ProjectCandidateImportCommand
  ) => Promise<Result<ProjectCandidateImportSnapshot, DomainError>>;
  /**
   * 可选：向明确的同项目会话发送交接说明，可附候选引用。实现方负责目标可见性、
   * 权限与请求键幂等；`wake` 默认 false，只投递收件箱。
   */
  readonly handoff?: (
    command: ProjectSessionHandoffCommand
  ) => Promise<Result<ProjectSessionHandoffSnapshot, DomainError>>;
  /**
   * 可选：列出调用者可见的同项目会话。实现方按 `limit` 有界查询；provider 仍会
   * 再按白名单裁剪一次，避免路径 / 凭据 / 正文混进工具响应。
   */
  readonly listSessions?: (
    query: ProjectSessionListQuery
  ) => Promise<Result<readonly ProjectSessionSummary[], DomainError>>;
}

const TASK_INPUT_KEYS = new Set(['request_key', 'title', 'goal', 'parent_task_id']);
const WORKTREE_INPUT_KEYS = new Set([
  'request_key',
  'task_id',
  'repo_id',
  'base_branch',
  'instructions',
  'agent_id',
  'model',
  'profile_id'
]);
const CANDIDATE_IMPORT_INPUT_KEYS = new Set([
  'request_key',
  'source_session_id',
  'target_session_id',
  'repo_id',
  'sha'
]);
const CANDIDATE_REF_INPUT_KEYS = new Set(['source_session_id', 'repo_id', 'sha']);
const HANDOFF_INPUT_KEYS = new Set(['request_key', 'target_session_id', 'body', 'wake', 'candidate']);
const LIST_INPUT_KEYS = new Set(['limit']);

function taskCreateDescriptor(scope: ToolScope): ToolDescriptor {
  return {
    name: PROJECT_TASK_CREATE_TOOL_NAME,
    version: 1,
    scope,
    perMinute: 6,
    description:
      'Create a task in the current project. The parent task is optional and must belong to the same project. Returns { task: { id, projectId, parentTaskId, status } }. This never creates a session, worktree, or delegation; reuse the same request key on retries.',
    inputSchema: {
      type: 'object',
      properties: {
        request_key: {
          type: 'string',
          minLength: 1,
          maxLength: REQUEST_KEY_MAX,
          description: 'Stable idempotency key chosen by you; reuse it verbatim when retrying the same creation.'
        },
        title: {
          type: 'string',
          minLength: 1,
          maxLength: TITLE_MAX,
          description: 'Task title, scoped to the project bound to this session.'
        },
        goal: {
          type: 'string',
          maxLength: GOAL_MAX,
          description: 'Optional task goal. It is stored on the task and never echoed back by this tool.'
        },
        parent_task_id: {
          type: 'string',
          minLength: 1,
          maxLength: ID_MAX,
          description: 'Optional existing parent task id in the same project. Parentage is fixed at creation.'
        }
      },
      required: ['request_key', 'title'],
      additionalProperties: false
    }
  };
}

function worktreeStartDescriptor(scope: ToolScope): ToolDescriptor {
  return {
    name: PROJECT_WORKTREE_START_TOOL_NAME,
    version: 1,
    scope,
    perMinute: 6,
    description:
      'Start a delegated execution session for an existing task in the current project: prepare a strict Git worktree for the chosen repo/base branch and deliver the instructions. Returns { worktree: { delegationId, executionSessionId, workspaceId, taskId, repoId, branch, baseSha } }. Reuse the same request key on retries; a replay must not create another worktree or session.',
    inputSchema: {
      type: 'object',
      properties: {
        request_key: {
          type: 'string',
          minLength: 1,
          maxLength: REQUEST_KEY_MAX,
          description: 'Stable idempotency key chosen by you; reuse it verbatim when retrying the same delegation.'
        },
        task_id: {
          type: 'string',
          minLength: 1,
          maxLength: ID_MAX,
          description: 'Existing task id in the same project as this session.'
        },
        repo_id: {
          type: 'string',
          minLength: 1,
          maxLength: ID_MAX,
          description: 'Project repository id (not a URL, path, or remote name).'
        },
        base_branch: {
          type: 'string',
          minLength: 1,
          maxLength: ID_MAX,
          description: 'Explicit base branch for the new worktree.'
        },
        instructions: {
          type: 'string',
          minLength: 1,
          maxLength: INSTRUCTIONS_MAX,
          description: 'Self-contained instructions for the execution session. Never echoed back.'
        },
        agent_id: {
          type: 'string',
          minLength: 1,
          maxLength: ID_MAX,
          description: 'Agent runtime id for the execution session.'
        },
        model: {
          type: 'string',
          minLength: 1,
          maxLength: EXECUTION_CONFIG_MAX,
          description: 'Optional explicit model id; omit to use the agent/default configuration.'
        },
        profile_id: {
          type: 'string',
          minLength: 1,
          maxLength: EXECUTION_CONFIG_MAX,
          description: 'Optional explicit agent profile id; omit to use the agent/default configuration.'
        }
      },
      required: ['request_key', 'task_id', 'repo_id', 'base_branch', 'instructions', 'agent_id'],
      additionalProperties: false
    }
  };
}

function candidateImportDescriptor(scope: ToolScope): ToolDescriptor {
  return {
    name: PROJECT_CANDIDATE_IMPORT_TOOL_NAME,
    version: 1,
    scope,
    perMinute: 6,
    description:
      'Import an exact candidate commit from a source session into the target session repository as a dedicated ref. This never checks out, switches branches, overwrites branches, or pushes. Returns { ref, sha, alreadyPresent, targetSessionId }. Reuse the same request key and parameters on retries.',
    inputSchema: {
      type: 'object',
      properties: {
        request_key: {
          type: 'string',
          minLength: 1,
          maxLength: REQUEST_KEY_MAX,
          description: 'Stable idempotency key chosen by you; reuse it verbatim when retrying the same import.'
        },
        source_session_id: {
          type: 'string',
          minLength: 1,
          maxLength: ID_MAX,
          description: 'Session whose repository contains the candidate commit.'
        },
        target_session_id: {
          type: 'string',
          minLength: 1,
          maxLength: ID_MAX,
          description: 'Session whose repository should receive the dedicated ref.'
        },
        repo_id: {
          type: 'string',
          minLength: 1,
          maxLength: ID_MAX,
          description: 'Project repository id shared by both sessions (not a URL, path, or remote name).'
        },
        sha: {
          type: 'string',
          minLength: SHA_LENGTH,
          maxLength: SHA_LENGTH,
          description: 'Full 40-character lowercase commit SHA to import.'
        }
      },
      required: ['request_key', 'source_session_id', 'target_session_id', 'repo_id', 'sha'],
      additionalProperties: false
    }
  };
}

function handoffDescriptor(scope: ToolScope): ToolDescriptor {
  return {
    name: PROJECT_SESSION_HANDOFF_TOOL_NAME,
    version: 1,
    scope,
    perMinute: 12,
    description:
      'Send a handoff message to an explicit session in the same project. By default the message only lands in the target inbox (wake=false); set wake=true to queue and attempt one wake-up round. An optional candidate reference is metadata only and never authorizes an import. Returns { messageId, targetSessionId, status, wake }. Reuse the same request key and parameters on retries.',
    inputSchema: {
      type: 'object',
      properties: {
        request_key: {
          type: 'string',
          minLength: 1,
          maxLength: REQUEST_KEY_MAX,
          description: 'Stable idempotency key chosen by you; reuse it verbatim when retrying the same handoff.'
        },
        target_session_id: {
          type: 'string',
          minLength: 1,
          maxLength: ID_MAX,
          description: 'Explicit target session id in the same project (use project.session.list to discover it).'
        },
        body: {
          type: 'string',
          minLength: 1,
          maxLength: BODY_MAX,
          description: 'Handoff instructions. It is delivered as-is and never echoed back.'
        },
        wake: {
          type: 'boolean',
          description: 'Defaults to false: inbox delivery only. true queues the message and attempts one wake-up round.'
        },
        candidate: {
          type: 'object',
          properties: {
            source_session_id: {
              type: 'string',
              minLength: 1,
              maxLength: ID_MAX,
              description: 'Session whose repository contains the candidate commit.'
            },
            repo_id: {
              type: 'string',
              minLength: 1,
              maxLength: ID_MAX,
              description: 'Project repository id for the candidate.'
            },
            sha: {
              type: 'string',
              minLength: SHA_LENGTH,
              maxLength: SHA_LENGTH,
              description: 'Full 40-character lowercase candidate commit SHA.'
            }
          },
          required: ['source_session_id', 'repo_id', 'sha'],
          additionalProperties: false,
          description: 'Optional candidate reference carried with the handoff. It does not authorize an import.'
        }
      },
      required: ['request_key', 'target_session_id', 'body'],
      additionalProperties: false
    }
  };
}

function sessionListDescriptor(scope: ToolScope): ToolDescriptor {
  return {
    name: PROJECT_SESSION_LIST_TOOL_NAME,
    version: 1,
    scope,
    perMinute: 30,
    description:
      'List sessions in the current project that you are allowed to see. Returns a bounded, safe summary { sessions: [{ sessionId, taskId, title, status, agentId }], truncated }. It never includes workspace paths, remotes, credentials, or message bodies.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: LIST_MAX,
          description: `Maximum number of sessions to return (default ${LIST_DEFAULT}, max ${LIST_MAX}).`
        }
      },
      required: [],
      additionalProperties: false
    }
  };
}

/* 通用输入校验（hasControl / asObject / rejectUnknownKeys / exactString / requiredExact）
   与资产工具共用同一份实现；这里只保留会话工具自己的 trim / 正文 / 分支语义。 */

/** 标题 / 目标：按 trim 后语义使用；目标允许为空（存 null）。 */
function requiredText(
  raw: Record<string, unknown>,
  key: string,
  max: number
): Result<string, DomainError> {
  const value = raw[key];
  if (typeof value !== 'string') return err(invalid(`${key} 必须是字符串`));
  const trimmed = value.trim();
  if (trimmed === '') return err(invalid(`${key} 不能为空`));
  if (trimmed.length > max) return err(invalid(`${key} 不能超过 ${max} 字符`));
  return ok(trimmed);
}

function optionalText(
  raw: Record<string, unknown>,
  key: string,
  max: number
): Result<string | null, DomainError> {
  const value = raw[key];
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== 'string') return err(invalid(`${key} 必须是字符串`));
  const trimmed = value.trim();
  if (trimmed.length > max) return err(invalid(`${key} 不能超过 ${max} 字符`));
  return ok(trimmed === '' ? null : trimmed);
}

/** 正文类指令原样交付（保留换行与缩进），只要求 trim 后非空。 */
function requiredVerbatim(
  raw: Record<string, unknown>,
  key: string,
  max: number
): Result<string, DomainError> {
  const value = raw[key];
  if (typeof value !== 'string') return err(invalid(`${key} 必须是字符串`));
  if (value.trim() === '') return err(invalid(`${key} 不能为空`));
  if (value.length > max) return err(invalid(`${key} 不能超过 ${max} 字符`));
  return ok(value);
}

/** 分支名只做基本合法性；权威规范化仍在领域 / 派工实现里。 */
function checkBranch(value: string): DomainError | null {
  if (/\s/.test(value) || value.includes('..') || value.includes('~')) {
    return invalid('base_branch 不合法');
  }
  if (value.startsWith('/') || value.endsWith('/')) return invalid('base_branch 不合法');
  return null;
}

interface ParsedTaskCreate {
  readonly requestKey: string;
  readonly title: string;
  readonly goal: string | null;
  readonly parentTaskId: string | null;
}

function parseTaskCreate(input: unknown): Result<ParsedTaskCreate, DomainError> {
  const object = asObject(input);
  if (!object.ok) return object;
  const raw = object.value;

  const unknown = rejectUnknownKeys(raw, TASK_INPUT_KEYS);
  if (unknown) return err(unknown);

  const requestKey = requiredExact(raw, 'request_key', REQUEST_KEY_MAX);
  if (!requestKey.ok) return requestKey;
  const title = requiredText(raw, 'title', TITLE_MAX);
  if (!title.ok) return title;
  const goal = optionalText(raw, 'goal', GOAL_MAX);
  if (!goal.ok) return goal;
  const parentTaskId = exactString(raw, 'parent_task_id', ID_MAX);
  if (!parentTaskId.ok) return parentTaskId;

  return ok({
    requestKey: requestKey.value,
    title: title.value,
    goal: goal.value,
    parentTaskId: parentTaskId.value
  });
}

interface ParsedWorktreeStart {
  readonly requestKey: string;
  readonly taskId: string;
  readonly repoId: string;
  readonly baseBranch: string;
  readonly instructions: string;
  readonly agentId: string;
  readonly model: string | null;
  readonly profileId: string | null;
}

function parseWorktreeStart(input: unknown): Result<ParsedWorktreeStart, DomainError> {
  const object = asObject(input);
  if (!object.ok) return object;
  const raw = object.value;

  const unknown = rejectUnknownKeys(raw, WORKTREE_INPUT_KEYS);
  if (unknown) return err(unknown);

  const requestKey = requiredExact(raw, 'request_key', REQUEST_KEY_MAX);
  if (!requestKey.ok) return requestKey;
  const taskId = requiredExact(raw, 'task_id', ID_MAX);
  if (!taskId.ok) return taskId;
  const repoId = requiredExact(raw, 'repo_id', ID_MAX);
  if (!repoId.ok) return repoId;
  const baseBranch = requiredExact(raw, 'base_branch', ID_MAX);
  if (!baseBranch.ok) return baseBranch;
  const branchError = checkBranch(baseBranch.value);
  if (branchError) return err(branchError);
  const instructions = requiredVerbatim(raw, 'instructions', INSTRUCTIONS_MAX);
  if (!instructions.ok) return instructions;
  const agentId = requiredExact(raw, 'agent_id', ID_MAX);
  if (!agentId.ok) return agentId;
  const model = exactString(raw, 'model', EXECUTION_CONFIG_MAX);
  if (!model.ok) return model;
  const profileId = exactString(raw, 'profile_id', EXECUTION_CONFIG_MAX);
  if (!profileId.ok) return profileId;

  return ok({
    requestKey: requestKey.value,
    taskId: taskId.value,
    repoId: repoId.value,
    baseBranch: baseBranch.value,
    instructions: instructions.value,
    agentId: agentId.value,
    model: model.value,
    profileId: profileId.value
  });
}

function requiredSha(raw: Record<string, unknown>, key: string): Result<string, DomainError> {
  const parsed = requiredExact(raw, key, SHA_LENGTH);
  if (!parsed.ok) return parsed;
  if (!SHA_PATTERN.test(parsed.value)) {
    return err(invalid(`${key} 必须是 ${SHA_LENGTH} 位小写提交号`));
  }
  return ok(parsed.value);
}

function parseCandidateRef(input: unknown): Result<ProjectCandidateRef, DomainError> {
  const object = asObject(input);
  if (!object.ok) return object;
  const raw = object.value;

  const unknown = rejectUnknownKeys(raw, CANDIDATE_REF_INPUT_KEYS);
  if (unknown) return err(unknown);

  const sourceSessionId = requiredExact(raw, 'source_session_id', ID_MAX);
  if (!sourceSessionId.ok) return sourceSessionId;
  const repoId = requiredExact(raw, 'repo_id', ID_MAX);
  if (!repoId.ok) return repoId;
  const sha = requiredSha(raw, 'sha');
  if (!sha.ok) return sha;

  return ok({
    sourceSessionId: asSessionId(sourceSessionId.value),
    repoId: repoId.value,
    sha: sha.value
  });
}

interface ParsedCandidateImport {
  readonly requestKey: string;
  readonly sourceSessionId: SessionId;
  readonly targetSessionId: SessionId;
  readonly repoId: string;
  readonly sha: string;
}

function parseCandidateImport(input: unknown): Result<ParsedCandidateImport, DomainError> {
  const object = asObject(input);
  if (!object.ok) return object;
  const raw = object.value;

  const unknown = rejectUnknownKeys(raw, CANDIDATE_IMPORT_INPUT_KEYS);
  if (unknown) return err(unknown);

  const requestKey = requiredExact(raw, 'request_key', REQUEST_KEY_MAX);
  if (!requestKey.ok) return requestKey;
  const sourceSessionId = requiredExact(raw, 'source_session_id', ID_MAX);
  if (!sourceSessionId.ok) return sourceSessionId;
  const targetSessionId = requiredExact(raw, 'target_session_id', ID_MAX);
  if (!targetSessionId.ok) return targetSessionId;
  const repoId = requiredExact(raw, 'repo_id', ID_MAX);
  if (!repoId.ok) return repoId;
  const sha = requiredSha(raw, 'sha');
  if (!sha.ok) return sha;
  if (sourceSessionId.value === targetSessionId.value) {
    return err(invalid('source_session_id 与 target_session_id 不能相同'));
  }

  return ok({
    requestKey: requestKey.value,
    sourceSessionId: asSessionId(sourceSessionId.value),
    targetSessionId: asSessionId(targetSessionId.value),
    repoId: repoId.value,
    sha: sha.value
  });
}

interface ParsedHandoff {
  readonly requestKey: string;
  readonly targetSessionId: SessionId;
  readonly body: string;
  readonly wake: boolean;
  readonly candidate: ProjectCandidateRef | null;
}

function parseHandoff(input: unknown): Result<ParsedHandoff, DomainError> {
  const object = asObject(input);
  if (!object.ok) return object;
  const raw = object.value;

  const unknown = rejectUnknownKeys(raw, HANDOFF_INPUT_KEYS);
  if (unknown) return err(unknown);

  const requestKey = requiredExact(raw, 'request_key', REQUEST_KEY_MAX);
  if (!requestKey.ok) return requestKey;
  const targetSessionId = requiredExact(raw, 'target_session_id', ID_MAX);
  if (!targetSessionId.ok) return targetSessionId;
  const body = requiredVerbatim(raw, 'body', BODY_MAX);
  if (!body.ok) return body;

  let wake = false;
  if (raw.wake !== undefined && raw.wake !== null) {
    if (typeof raw.wake !== 'boolean') return err(invalid('wake 必须是布尔值'));
    wake = raw.wake;
  }

  let candidate: ProjectCandidateRef | null = null;
  if (raw.candidate !== undefined && raw.candidate !== null) {
    const parsed = parseCandidateRef(raw.candidate);
    if (!parsed.ok) return parsed;
    candidate = parsed.value;
  }

  return ok({
    requestKey: requestKey.value,
    targetSessionId: asSessionId(targetSessionId.value),
    body: body.value,
    wake,
    candidate
  });
}

function parseSessionList(input: unknown): Result<{ limit: number }, DomainError> {
  const object = asObject(input);
  if (!object.ok) return object;
  const raw = object.value;

  const unknown = rejectUnknownKeys(raw, LIST_INPUT_KEYS);
  if (unknown) return err(unknown);

  if (raw.limit === undefined || raw.limit === null) return ok({ limit: LIST_DEFAULT });
  if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit)) {
    return err(invalid('limit 必须是整数'));
  }
  if (raw.limit < 1 || raw.limit > LIST_MAX) {
    return err(invalid(`limit 必须在 1 到 ${LIST_MAX} 之间`));
  }
  return ok({ limit: raw.limit });
}

/**
 * 只从冻结的工具授权里取身份：payload 里的 actor / project_id / session 参数根本不存在。
 * 更深一层的「这个人现在还能不能在这个项目写」由回调每次重新查。
 */
function bindingOf(ctx: ToolContext): Result<ProjectToolBinding, DomainError> {
  const actor = ctx.grant.actor;
  if (!actor || actor.userId === null) {
    return err(forbidden('项目会话写工具需要明确的调用身份'));
  }
  return ok({
    actorId: actor.userId,
    actorVia: actor.via,
    sessionId: ctx.grant.sessionId
  });
}

function assertSeparateScopes(scopes: ProjectSessionToolScopes): void {
  if (!scopes.taskCreate || !scopes.worktreeStart) {
    throw new Error('project session tools require both taskCreate and worktreeStart scopes');
  }
  if (scopes.taskCreate === scopes.worktreeStart) {
    throw new Error('project session tools require distinct taskCreate and worktreeStart scopes');
  }
}

/** 可选工具必须 scope 与回调同时出现，避免「给了权限但没人实现」或「实现了却漏挂权限」。 */
function assertOptionalCapability(
  label: 'candidateImport' | 'handoff' | 'sessionList',
  scope: ToolScope | undefined,
  callback: unknown
): void {
  if ((scope === undefined) !== (callback === undefined)) {
    throw new Error(`project session tools require both ${label} scope and ${label} callback`);
  }
}

/** 每个启用的工具都要独立 scope，防止候选导入 / 交接 / 列表搭上建任务的权限。 */
function assertAllScopesDistinct(scopes: ProjectSessionToolScopes): void {
  const configured: ToolScope[] = [
    scopes.taskCreate,
    scopes.worktreeStart,
    ...(scopes.candidateImport === undefined ? [] : [scopes.candidateImport]),
    ...(scopes.handoff === undefined ? [] : [scopes.handoff]),
    ...(scopes.sessionList === undefined ? [] : [scopes.sessionList])
  ];
  const seen = new Set<ToolScope>();
  for (const scope of configured) {
    if (seen.has(scope)) {
      throw new Error('project session tools require distinct scopes for every enabled tool');
    }
    seen.add(scope);
  }
}

/** 白名单式重组：即使回调对象上多带了字段，也只返回这四个。 */
function candidateImportResult(
  command: ProjectCandidateImportCommand,
  value: ProjectCandidateImportSnapshot
): Result<unknown, DomainError> {
  if (
    value === null ||
    typeof value !== 'object' ||
    value.ref !== `refs/agent-hub/imports/${command.targetSessionId}/${command.sha}` ||
    typeof value.sha !== 'string' ||
    !SHA_PATTERN.test(value.sha) ||
    value.sha !== command.sha ||
    typeof value.alreadyPresent !== 'boolean' ||
    value.targetSessionId !== command.targetSessionId
  ) {
    return err(unavailable('候选导入结果无法核实'));
  }
  return ok({
    ref: value.ref,
    sha: value.sha,
    alreadyPresent: value.alreadyPresent,
    targetSessionId: value.targetSessionId
  });
}

/** 只回消息标识与状态；正文、目标路径和凭据一律不进入响应。 */
function handoffResult(
  command: ProjectSessionHandoffCommand,
  value: ProjectSessionHandoffSnapshot
): Result<unknown, DomainError> {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.messageId !== 'string' ||
    value.messageId.length === 0 ||
    value.messageId.length > ID_MAX ||
    hasControl(value.messageId) ||
    value.targetSessionId !== command.targetSessionId ||
    typeof value.status !== 'string' ||
    value.status.length === 0 ||
    value.status.length > LIST_STATUS_MAX ||
    hasControl(value.status) ||
    typeof value.wake !== 'boolean' ||
    value.wake !== command.wake
  ) {
    return err(unavailable('交接结果无法核实'));
  }
  return ok({
    messageId: value.messageId,
    targetSessionId: value.targetSessionId,
    status: value.status,
    wake: value.wake
  });
}

function safeOptionalId(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > max || hasControl(value)) return undefined;
  return value;
}

function safeTitle(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  return value.slice(0, LIST_TITLE_MAX).replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/** 列表同样按白名单重建；条目不合格时整次失败，不把无法核实的对象透传出去。 */
function sessionListResult(
  limit: number,
  rows: readonly ProjectSessionSummary[]
): Result<ProjectSessionListSnapshot, DomainError> {
  if (!Array.isArray(rows)) return err(unavailable('会话列表无法核实'));

  const sessions: ProjectSessionSummary[] = [];
  for (const row of rows.slice(0, limit)) {
    if (row === null || typeof row !== 'object') {
      return err(unavailable('会话列表无法核实'));
    }
    const sessionId = (row as { sessionId?: unknown }).sessionId;
    const taskId = safeOptionalId((row as { taskId?: unknown }).taskId, ID_MAX);
    const title = safeTitle((row as { title?: unknown }).title);
    const status = (row as { status?: unknown }).status;
    const agentId = (row as { agentId?: unknown }).agentId;

    if (
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      sessionId.length > ID_MAX ||
      hasControl(sessionId) ||
      taskId === undefined ||
      title === undefined ||
      typeof status !== 'string' ||
      status.length === 0 ||
      status.length > LIST_STATUS_MAX ||
      hasControl(status) ||
      typeof agentId !== 'string' ||
      agentId.length === 0 ||
      agentId.length > ID_MAX ||
      hasControl(agentId)
    ) {
      return err(unavailable('会话列表无法核实'));
    }

    sessions.push({
      sessionId: asSessionId(sessionId),
      taskId,
      title,
      status,
      agentId
    });
  }

  return ok({ sessions, truncated: rows.length > limit });
}

interface CandidateImportCapability {
  readonly tool: ToolDescriptor;
  readonly run: NonNullable<ProjectSessionToolDeps['importCandidate']>;
}

interface HandoffCapability {
  readonly tool: ToolDescriptor;
  readonly run: NonNullable<ProjectSessionToolDeps['handoff']>;
}

interface SessionListCapability {
  readonly tool: ToolDescriptor;
  readonly run: NonNullable<ProjectSessionToolDeps['listSessions']>;
}

function candidateImportCapability(deps: ProjectSessionToolDeps): CandidateImportCapability | null {
  const scope = deps.scopes.candidateImport;
  const run = deps.importCandidate;
  if (scope === undefined || run === undefined) return null;
  return { tool: candidateImportDescriptor(scope), run };
}

function handoffCapability(deps: ProjectSessionToolDeps): HandoffCapability | null {
  const scope = deps.scopes.handoff;
  const run = deps.handoff;
  if (scope === undefined || run === undefined) return null;
  return { tool: handoffDescriptor(scope), run };
}

function sessionListCapability(deps: ProjectSessionToolDeps): SessionListCapability | null {
  const scope = deps.scopes.sessionList;
  const run = deps.listSessions;
  if (scope === undefined || run === undefined) return null;
  return { tool: sessionListDescriptor(scope), run };
}

export function createProjectSessionToolProvider(deps: ProjectSessionToolDeps): ToolProvider {
  assertSeparateScopes(deps.scopes);
  assertOptionalCapability('candidateImport', deps.scopes.candidateImport, deps.importCandidate);
  assertOptionalCapability('handoff', deps.scopes.handoff, deps.handoff);
  assertOptionalCapability('sessionList', deps.scopes.sessionList, deps.listSessions);
  assertAllScopesDistinct(deps.scopes);

  const taskTool = taskCreateDescriptor(deps.scopes.taskCreate);
  const worktreeTool = worktreeStartDescriptor(deps.scopes.worktreeStart);
  const candidateImport = candidateImportCapability(deps);
  const handoff = handoffCapability(deps);
  const sessionList = sessionListCapability(deps);

  const tools: ToolDescriptor[] = [taskTool, worktreeTool];
  if (candidateImport) tools.push(candidateImport.tool);
  if (handoff) tools.push(handoff.tool);
  if (sessionList) tools.push(sessionList.tool);
  const enabled = new Set(tools.map(tool => tool.name));

  return {
    id: 'project-session-tools',
    tools: () => tools,
    async call(name, input, ctx): Promise<Result<unknown, DomainError>> {
      if (!enabled.has(name)) {
        return err(notFound(`未知工具：${name}`));
      }

      const binding = bindingOf(ctx);
      if (!binding.ok) return binding;

      if (name === taskTool.name) {
        const parsed = parseTaskCreate(input);
        if (!parsed.ok) return parsed;

        // 只创建任务：不建会话、不准备 worktree、不派工。
        const created = await deps.createTask({ ...binding.value, ...parsed.value });
        if (!created.ok) return created;
        return ok({
          task: {
            id: created.value.id,
            projectId: created.value.projectId,
            parentTaskId: created.value.parentTaskId ?? null,
            status: created.value.status
          }
        });
      }

      if (name === worktreeTool.name) {
        const parsed = parseWorktreeStart(input);
        if (!parsed.ok) return parsed;

        const started = await deps.startWorktree({ ...binding.value, ...parsed.value });
        if (!started.ok) return started;
        return ok({
          worktree: {
            delegationId: started.value.delegationId,
            executionSessionId: started.value.executionSessionId,
            workspaceId: started.value.workspaceId,
            taskId: started.value.taskId,
            repoId: started.value.repoId,
            branch: started.value.branch,
            baseSha: started.value.baseSha
          }
        });
      }

      if (candidateImport && name === candidateImport.tool.name) {
        const parsed = parseCandidateImport(input);
        if (!parsed.ok) return parsed;

        const command: ProjectCandidateImportCommand = { ...binding.value, ...parsed.value };
        const imported = await candidateImport.run(command);
        if (!imported.ok) return imported;
        return candidateImportResult(command, imported.value);
      }

      if (handoff && name === handoff.tool.name) {
        const parsed = parseHandoff(input);
        if (!parsed.ok) return parsed;

        // 默认 wake=false：只投递收件箱，是否唤醒由调用方显式要求。
        const command: ProjectSessionHandoffCommand = { ...binding.value, ...parsed.value };
        const accepted = await handoff.run(command);
        if (!accepted.ok) return accepted;
        return handoffResult(command, accepted.value);
      }

      const list = sessionList;
      if (list && name === list.tool.name) {
        const parsed = parseSessionList(input);
        if (!parsed.ok) return parsed;

        const query: ProjectSessionListQuery = { ...binding.value, limit: parsed.value.limit };
        const listed = await list.run(query);
        if (!listed.ok) return listed;
        return sessionListResult(query.limit, listed.value);
      }

      // 所有已启用名称都在上面处理；这里只可能是装配后的竞态，按未知工具处理。
      return err(notFound(`未知工具：${name}`));
    }
  };
}
