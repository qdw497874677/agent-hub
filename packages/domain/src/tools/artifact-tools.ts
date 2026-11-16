import { createArtifact, type Artifact } from '../artifact.ts';
import { forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import type { SessionId, TaskId } from '../ids.ts';
import type { ArtifactRepository } from '../ports/artifact-repository.ts';
import type { SessionRepository } from '../ports/session-repository.ts';
import type { ToolDescriptor, ToolProvider } from '../ports/tool-provider.ts';
import { err, ok, type Result } from '../result.ts';
import type { Deps } from '../use-cases/deps.ts';
import { appendWorkLogUseCase } from '../use-cases/work-log.ts';

/**
 * artifact.*（issue #216 P2）：任务 / 会话的产出物。
 *
 * 现有数据模型里 Artifact 只有 { path, bytes, label }：工作空间里产生的文件由会话事件落成
 * path=相对路径、bytes=大小、label=文件名；「引用型产物」则复用同一张表，path=外部 URL、
 * bytes=0、label=标题。Artifact 没有 description 列，所以 artifact.add 的说明写进任务工作日志
 * （system 条目，不改「当前进展」），既能留档也不改存储 schema。
 *
 * 权限：add 需要 task:log:write（它同时会写一条任务日志；不额外放开），list/get 需要 task:read。
 */
export const ARTIFACT_LIMITS = {
  title: 200,
  description: 2000
} as const;

export interface ArtifactToolDeps {
  readonly sessions: Pick<SessionRepository, 'byId'>;
  readonly artifacts: Pick<ArtifactRepository, 'save' | 'bySession' | 'byTask'>;
  /** 只给 artifact.add 写说明用（appendWorkLogUseCase）。 */
  readonly tasks: Deps['tasks'];
  readonly workLog: Deps['workLog'];
  readonly now: () => number;
}

export const ARTIFACT_TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'artifact.list',
    version: 1,
    scope: 'artifact',
    perMinute: 12,
    description:
      '列出当前任务（没有任务的容器会话则列出当前会话）的产出物，按创建时间倒序。' +
      '何时用：想知道这个任务已经产出了哪些文件或外部链接、或需要 artifact id 时；不确定就先列一遍，不要猜 id。' +
      '参数：无。' +
      '返回：{ artifacts: [{ id, title, type, size, created_at, link?, path? }] }。type=file 是工作空间里的文件（path 为相对路径），type=link 是外部引用（link 为 http(s) 地址）。' +
      '下一步与错误：拿 id 调 artifact.get 看单条；要登记新的外部链接用 artifact.add。会话不存在返回 notFound。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'artifact.add',
    version: 1,
    scope: 'artifact',
    perMinute: 12,
    description:
      '给当前任务登记一条引用型产物（外部网页 / 文档 / 设计稿等 http(s) 链接），不下载、不上传文件。' +
      '何时用：交付物在任务工作空间之外、但需要让任务卡和后续会话看得到时；工作空间里已有的文件会被平台自动登记，不要重复加。' +
      '参数：title（必填，≤200 字）、url（必填，http/https）、description（可选，≤2000 字；会作为一条任务日志留档）。' +
      '返回：{ id, task_id, title, url, type: "link", size: 0, created_at, logged }；logged 表示说明是否成功写进任务日志。' +
      '下一步与错误：用返回的 id 可以 artifact.get。没有任务（容器会话）返回 forbidden；缺标题 / 非 http(s) URL / 超长返回 invalid；没有 task:log:write 授权返回 forbidden。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: ARTIFACT_LIMITS.title, description: '产物标题，也是列表里显示的名字。' },
        url: { type: 'string', minLength: 1, description: '外部链接，必须以 http:// 或 https:// 开头。' },
        description: {
          type: 'string',
          maxLength: ARTIFACT_LIMITS.description,
          description: '这个产物是什么、怎么用；写进任务日志留档。'
        }
      },
      required: ['title', 'url'],
      additionalProperties: false
    }
  },
  {
    name: 'artifact.get',
    version: 1,
    scope: 'artifact',
    perMinute: 12,
    description:
      '按 id 读取当前任务（容器会话则当前会话）里的一条产出物详情。' +
      '何时用：已经从 artifact.list 拿到 id，需要确认它的标题、类型、大小、创建时间或链接时。' +
      '参数：id（必填，artifact.list 返回的 id）。' +
      '返回：{ id, title, type, size, created_at, session_id, task_id, link?, path? }。' +
      '下一步与错误：要读工作空间里的文件内容用 workspace.read（path 取返回的 path）。id 不存在或属于别的任务一律 notFound（不区分，避免泄露别的任务有什么）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, description: '产物的 id（artifact.list 返回的）。' }
      },
      required: ['id'],
      additionalProperties: false
    }
  }
];

const record = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** 网关不校验 JSON Schema，未知字段在这里显式拒掉。 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'artifact.list': [],
  'artifact.add': ['title', 'url', 'description'],
  'artifact.get': ['id']
};

const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

interface ArtifactView {
  readonly id: string;
  readonly title: string;
  readonly type: 'file' | 'link';
  readonly size: number;
  readonly created_at: number;
  readonly session_id: string;
  readonly task_id: string;
  readonly link?: string;
  readonly path?: string;
}

const viewOf = (artifact: Artifact): ArtifactView => {
  // 引用型产物用 http(s) 的 path 表示；工作空间文件是相对路径。
  const link = /^https?:\/\//i.test(artifact.path);
  const title = artifact.label || (artifact.path.split('/').pop() ?? artifact.path);
  return {
    id: artifact.id,
    title,
    type: link ? 'link' : 'file',
    size: artifact.bytes,
    created_at: artifact.createdAt,
    session_id: artifact.sessionId,
    task_id: artifact.taskId,
    ...(link ? { link: artifact.path } : { path: artifact.path })
  };
};

export function createArtifactToolProvider(deps: ArtifactToolDeps): ToolProvider {
  /** 当前任务 / 会话的产物：有任务按任务汇总，容器会话只能按会话（通常为空）。 */
  const rowsFor = async (taskId: TaskId | null, sessionId: SessionId): Promise<readonly Artifact[]> =>
    taskId === null ? deps.artifacts.bySession(sessionId) : deps.artifacts.byTask(taskId);

  return {
    id: 'artifact',
    tools: () => ARTIFACT_TOOLS,
    async call(name, input, ctx): Promise<Result<unknown, DomainError>> {
      const allowed = ALLOWED[name];
      if (!allowed) return err(notFound(`没有这个工具：${name}`));
      const args = record(input);
      const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
      if (unknown.length > 0) return err(invalid(`不认识的参数：${unknown.join(', ')}`));

      const session = await deps.sessions.byId(ctx.grant.sessionId);
      if (!session) return err(notFound('找不到这条会话'));
      const taskId = ctx.grant.taskId;
      const sessionId = ctx.grant.sessionId;

      if (name === 'artifact.list') {
        if (!ctx.grant.scopes.includes('task:read')) return err(forbidden('这条会话没有 task:read 权限'));
        const rows = [...(await rowsFor(taskId, sessionId))].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
        return ok({ artifacts: rows.map(viewOf) });
      }

      if (name === 'artifact.get') {
        if (!ctx.grant.scopes.includes('task:read')) return err(forbidden('这条会话没有 task:read 权限'));
        const id = str(args['id']);
        if (!id) return err(invalid('id 必填'));
        const rows = await rowsFor(taskId, sessionId);
        const found = rows.find((artifact) => artifact.id === id);
        // 跨任务 / 别的会话的产物一律 404：不暴露「存在但你看不到」。
        if (!found) return err(notFound('没有这个产物'));
        return ok(viewOf(found));
      }

      // artifact.add
      if (!ctx.grant.scopes.includes('task:log:write')) {
        return err(forbidden('登记产物需要 task:log:write 权限（会同时写一条任务日志）'));
      }
      if (taskId === null) return err(forbidden('这条会话不属于任何任务，产物只能挂在任务上'));

      const title = str(args['title']);
      if (!title) return err(invalid('title 必填'));
      if (title.length > ARTIFACT_LIMITS.title) return err(invalid(`title 最多 ${ARTIFACT_LIMITS.title} 字`));
      const url = str(args['url']);
      if (!url) return err(invalid('url 必填'));
      if (!isHttpUrl(url)) return err(invalid('url 必须是 http(s) 链接'));
      let description = '';
      if (args['description'] !== undefined) {
        if (typeof args['description'] !== 'string') return err(invalid('description 必须是字符串'));
        description = args['description'].trim();
        if (description.length > ARTIFACT_LIMITS.description) {
          return err(invalid(`description 最多 ${ARTIFACT_LIMITS.description} 字`));
        }
      }

      const created = createArtifact({ sessionId, taskId, path: url, bytes: 0, now: deps.now() });
      if (!created.ok) return created;
      // label 存标题（createArtifact 默认取 URL 的最后一段，不适合当标题）。
      const artifact: Artifact = { ...created.value, label: title };
      await deps.artifacts.save(artifact);

      // 说明没有列可存：留一条 system 日志（不改「当前进展」），并把链接挂上。
      let logged = false;
      try {
        const note = await appendWorkLogUseCase(deps, {
          taskId,
          author: { kind: 'system' },
          body: description || `引用产物「${title}」：${url}`,
          links: [
            { kind: 'artifact', ref: artifact.id, label: title },
            { kind: 'url', ref: url, label: title }
          ],
          sessionId
        });
        logged = note.ok;
      } catch {
        logged = false;
      }

      return ok({
        id: artifact.id,
        task_id: taskId,
        title,
        url,
        type: 'link' as const,
        size: 0,
        created_at: artifact.createdAt,
        logged
      });
    }
  };
}
