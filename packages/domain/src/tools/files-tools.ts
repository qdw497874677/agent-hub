import type { Subject } from '../access.ts';
import { invalid, notFound, type DomainError } from '../errors.ts';
import type { SessionId } from '../ids.ts';
import type { ToolDescriptor, ToolProvider } from '../ports/tool-provider.ts';
import { ok, err, type Result } from '../result.ts';
import type { WorkspaceFilesService } from '../use-cases/workspace-files.ts';
import type { GitState } from '../use-cases/git-workflow.ts';

/**
 * workspace.*（issue #216 P2）：让会话里的 agent 只读地看自己工作空间的文件。
 *
 * 全部复用 WorkspaceFilesService：路径规则（相对根、拒 `..` / 绝对路径）、realpath 防符号链接逃逸、
 * 会话可见性（session.read）与 `workspace.files.read` 权限、敏感文件确认、每用户限流都在 service 里。
 * 工具层只做三件事：参数校验、把读取上限收窄到 64 KiB（最多 256 KiB）、把字节解成文本。
 * 不提供写：写入仍走会话里的普通编辑工具与 git 工作流。
 */
export const WORKSPACE_FILE_LIMITS = {
  /** 默认每次最多读 64 KiB：足够看一个源码文件，又不会把大文件灌进上下文。 */
  defaultReadBytes: 64 * 1024,
  /** 硬上限 256 KiB。 */
  maxReadBytes: 256 * 1024,
  /** 一层目录最多返回 200 条。 */
  listEntries: 200
} as const;

export interface FilesToolDeps {
  readonly files: WorkspaceFilesService;
  /** 同 git 工具：会话归属的账号（bot 或用户），用于 service 的权限判定。 */
  readonly subjectOf: (sessionId: SessionId) => Promise<Subject | null>;
  /**
   * 只读看同伴（会话通信 P1c）：把 session 参数（`session:<id>` / `peer:<短名>`）解析成能到达的会话。
   * 不给就不支持 session 参数。权限仍由 service 按调用方主体判（对方会话 session.read + workspace.files.read）。
   */
  readonly resolvePeer?: (fromSessionId: SessionId, address: string) => Promise<Result<SessionId, DomainError>>;
  /** workspace.changes 用：git 工作流的 state（分支、改动文件、领先、上游）。 */
  readonly gitState?: (subject: Subject | null, sessionId: SessionId, member?: string) => Promise<Result<GitState, DomainError>>;
}

const SESSION_PARAM = {
  type: 'string',
  description: '可选：看已连线同伴的工作空间（只读），写 peer:<短名> 或 session:<id>；不传 = 自己的。敏感文件一律不给，没有写入口。'
};
const CHANGES_FILES_MAX = 200;

export const WORKSPACE_TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'workspace.list',
    version: 1,
    scope: 'files',
    perMinute: 30,
    description:
      '列当前会话工作空间里的一层目录（不递归）。' +
      '何时用：刚进入任务、想知道仓库里有什么，或不确定文件路径时；比凭记忆猜路径可靠。要读文件内容用 workspace.read。' +
      '参数：path（可选，相对工作空间根的目录，默认根目录 ""）、member（可选，组合工作空间里的仓库 workspaceId；单仓库会话忽略）、session（可选，peer:<短名> / session:<id> 看已连线同伴的工作空间，只读）。' +
      '返回：{ path, entries: [{ name, type, size, modified_at, sensitive }], total, truncated }；type 是 file / dir / symlink，truncated=true 表示超过 200 条只给前 200 条。' +
      '下一步与错误：拿 entries 里的 name 拼相对 path 调 workspace.read。路径含 .. 或绝对路径返回 invalid；没有 workspace.files.read 权限返回 forbidden；会话不存在或没有工作空间返回 notFound / invalid。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作空间根的目录，默认 ""（根目录）。' },
        member: { type: 'string', description: '组合工作空间里的仓库 workspaceId；单仓库会话不用传。' },
        session: SESSION_PARAM
      },
      additionalProperties: false
    }
  },
  {
    name: 'workspace.read',
    version: 1,
    scope: 'files',
    perMinute: 30,
    description:
      '读当前会话工作空间里的一个文本文件（按 UTF-8 解码）。' +
      '何时用：需要看源码、配置、日志内容时；只读，不改文件。想先知道有哪些文件用 workspace.list。' +
      `参数：path（必填，相对工作空间根的路径，如 src/a.ts）、maxBytes（可选，默认 ${WORKSPACE_FILE_LIMITS.defaultReadBytes}，上限 ${WORKSPACE_FILE_LIMITS.maxReadBytes}，超过按上限截断）、member（可选，组合工作空间里的仓库 workspaceId）、session（可选，peer:<短名> / session:<id> 读已连线同伴的文件，只读）。` +
      '返回：{ path, size, modified_at, binary, truncated, content }；size 是文件完整大小，truncated=true 表示 content 只是开头一段；binary=true 时不返回内容（二进制文件请用别的工具或让用户看）。' +
      '下一步与错误：要看更后面的一段就换一个文件或让用户提供片段（不支持 offset）。绝对路径 / 含 .. / 符号链接指向根外返回 invalid（路径不合法）；敏感文件（.env、密钥等）本工具不代确认，返回 invalid，需要用户在界面里确认；没有 workspace.files.read 权限返回 forbidden；文件不存在返回 notFound。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: '相对工作空间根的文件路径。' },
        maxBytes: { type: 'integer', minimum: 1, description: `最多读多少字节，默认 ${WORKSPACE_FILE_LIMITS.defaultReadBytes}，上限 ${WORKSPACE_FILE_LIMITS.maxReadBytes}。` },
        member: { type: 'string', description: '组合工作空间里的仓库 workspaceId；单仓库会话不用传。' },
        session: SESSION_PARAM
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'workspace.changes',
    version: 1,
    scope: 'files',
    perMinute: 30,
    description:
      '看一个工作空间还没提交 / 没推送的改动摘要：分支、HEAD 之后改了哪些文件（状态 + 路径）、领先上游几个提交、上游分支。' +
      '何时用：同伴说「改好了」之前先看它改了什么；或要给同伴发 ref 前确认自己的分支。' +
      '参数：session（可选，peer:<短名> / session:<id>；不传 = 自己的）、member（可选，组合工作空间里的仓库 workspaceId）。' +
      '返回：{ session, branch, upstream, ahead, dirty, files: [{ path, status }], truncated }；文件最多 200 条。' +
      '下一步与错误：要看具体内容用 workspace.read（同一个 session）。没连线返回 forbidden（denied）；对方已收起返回 archived；机器离线返回 unavailable。',
    inputSchema: {
      type: 'object',
      properties: {
        session: SESSION_PARAM,
        member: { type: 'string', description: '组合工作空间里的仓库 workspaceId；单仓库会话不用传。' }
      },
      additionalProperties: false
    }
  }
];

const record = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** 网关不校验 JSON Schema，未知字段在这里显式拒掉。 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'workspace.list': ['path', 'member', 'session'],
  'workspace.read': ['path', 'maxBytes', 'member', 'session'],
  'workspace.changes': ['member', 'session']
};

/** member 只接受非空字符串；单仓库会话由 service 忽略。 */
const optionalMember = (args: Record<string, unknown>): Result<string | undefined, DomainError> => {
  if (args['member'] === undefined) return ok(undefined);
  const member = str(args['member']);
  if (!member) return err(invalid('member 必须是非空的 workspaceId'));
  return ok(member);
};

export function createWorkspaceToolProvider(deps: FilesToolDeps): ToolProvider {
  return {
    id: 'files',
    tools: () => (deps.gitState ? WORKSPACE_TOOLS : WORKSPACE_TOOLS.filter((tool) => tool.name !== 'workspace.changes')),
    async call(name, input, ctx): Promise<Result<unknown, DomainError>> {
      const allowed = ALLOWED[name];
      if (!allowed) return err(notFound(`没有这个工具：${name}`));
      const args = record(input);
      const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
      if (unknown.length > 0) return err(invalid(`不认识的参数：${unknown.join(', ')}`));

      const member = optionalMember(args);
      if (!member.ok) return member;
      const subject = await deps.subjectOf(ctx.grant.sessionId);
      let target: SessionId = ctx.grant.sessionId;
      if (args['session'] !== undefined) {
        const address = str(args['session']);
        if (!address) return err(invalid('session 要写成 peer:<短名> 或 session:<id>'));
        if (!deps.resolvePeer) return err(invalid('这台 hub 不支持看同伴的工作空间'));
        const resolved = await deps.resolvePeer(ctx.grant.sessionId, address);
        if (!resolved.ok) return resolved;
        target = resolved.value;
      }
      const peer = target !== ctx.grant.sessionId ? { session: `session:${target}` } : {};

      if (name === 'workspace.changes') {
        if (!deps.gitState) return err(notFound(`没有这个工具：${name}`));
        const state = await deps.gitState(subject, target, member.value);
        if (!state.ok) return state;
        const files = state.value.files.slice(0, CHANGES_FILES_MAX);
        return ok({
          session: `session:${target}`,
          isGit: state.value.isGit,
          branch: state.value.branch,
          upstream: state.value.upstream,
          ahead: state.value.ahead,
          dirty: state.value.files.length > 0,
          files,
          truncated: state.value.files.length > CHANGES_FILES_MAX
        });
      }

      if (name === 'workspace.list') {
        const path = args['path'] === undefined ? '' : str(args['path']);
        // service 自己会拒 ../ 绝对路径与 .agent-hub，这里只做类型归一。
        const page = await deps.files.list(subject, target, path, member.value);
        if (!page.ok) return page;
        const entries = page.value.entries.slice(0, WORKSPACE_FILE_LIMITS.listEntries);
        return ok({
          ...peer,
          path: page.value.path,
          entries: entries.map((entry) => ({
            name: entry.name,
            type: entry.type,
            size: entry.size,
            modified_at: entry.modifiedAt,
            sensitive: entry.sensitive
          })),
          total: page.value.entries.length,
          truncated: page.value.truncated || page.value.entries.length > WORKSPACE_FILE_LIMITS.listEntries
        });
      }

      const path = str(args['path']);
      if (!path) return err(invalid('path 必填'));
      let maxBytes: number = WORKSPACE_FILE_LIMITS.defaultReadBytes;
      if (args['maxBytes'] !== undefined) {
        const raw = args['maxBytes'];
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return err(invalid('maxBytes 必须是正整数'));
        maxBytes = Math.min(raw, WORKSPACE_FILE_LIMITS.maxReadBytes);
      }

      // confirmed 固定 false：agent 不代替用户确认敏感文件。
      const got = await deps.files.read(subject, target, path, false, member.value);
      if (!got.ok) return got;
      const file = got.value;
      if (file.binary) {
        return ok({ ...peer, path: file.path, size: file.size, modified_at: file.modifiedAt, binary: true, truncated: file.truncated, content: '' });
      }
      const cut = Math.min(maxBytes, file.bytes.byteLength);
      return ok({
        ...peer,
        path: file.path,
        size: file.size,
        modified_at: file.modifiedAt,
        binary: false,
        truncated: file.truncated || file.size > cut,
        content: new TextDecoder().decode(file.bytes.subarray(0, cut))
      });
    }
  };
}

/** 便于测试与调用方识别：工具层只读，没有写入口。 */
export const WORKSPACE_TOOL_NAMES = WORKSPACE_TOOLS.map((tool) => tool.name);
