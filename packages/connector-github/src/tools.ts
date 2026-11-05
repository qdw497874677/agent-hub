import type { DomainError, Result, ToolContext, ToolDescriptor, ToolProvider } from '@agent-hub/domain';
import { err, forbidden, invalid, ok } from '@agent-hub/domain';
import type { GithubClient } from './client.ts';
import { REACTIONS, githubCapabilitiesOf, isRepo, type GithubCapability, type Reaction } from './rules.ts';

export interface GithubToolDeps {
  readonly client: GithubClient;
  /** 这条会话所属 bot 的 github Binding：仓库 + 用哪个项目的 token。不是 bot 会话 = 空。 */
  readonly bindingsOf: (sessionId: string) => Promise<readonly { repo: string; projectId: string }[]>;
  readonly tokenFor: (projectId: string) => Promise<string | null>;
  /** 会话所在 Worker 的能力（ADR 0030）；本机 / 老凭据 = null（按完整）。 */
  readonly workerCapabilities: (sessionId: string) => Promise<readonly string[] | null>;
}

const TOOLS: readonly (ToolDescriptor & { cap: GithubCapability })[] = [
  {
    name: 'github.comment', version: 1, scope: 'connector', perMinute: 6, cap: 'connector.github.comment',
    description: 'Post a comment on an issue or pull request in a GitHub repo bound to you (the repos in your GitHub triggers). Use it to ask a clarifying question or report progress. There is no merge / close / push tool: code changes go through a PR that a human merges.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'owner/name' }, number: { type: 'integer' }, body: { type: 'string', maxLength: 8000 } }, required: ['repo', 'number', 'body'], additionalProperties: false }
  },
  {
    name: 'github.react', version: 1, scope: 'connector', perMinute: 20, cap: 'connector.github.react',
    description: 'Add an emoji reaction to an issue / PR (or to one of its comments with commentId) in a GitHub repo bound to you.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'integer' }, commentId: { type: 'integer' }, content: { type: 'string', enum: [...REACTIONS] } }, required: ['repo', 'number', 'content'], additionalProperties: false }
  }
];

export function createGithubToolProvider(deps: GithubToolDeps): ToolProvider {
  return {
    id: 'github',
    tools: () => TOOLS.map(({ cap: _cap, ...t }) => t),
    async call(name, input, ctx: ToolContext): Promise<Result<unknown, DomainError>> {
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return err(invalid(`没有工具 ${name}`));
      const a = (input ?? {}) as Record<string, unknown>;
      const sessionId = ctx.grant.sessionId as string;
      if (!githubCapabilitiesOf(await deps.workerCapabilities(sessionId)).includes(tool.cap)) return err(forbidden(`这台 Worker 的能力预设不允许 ${tool.cap}`));
      if (!isRepo(a.repo) || typeof a.number !== 'number' || !Number.isInteger(a.number) || a.number < 1) return err(invalid('要给 repo（owner/name）和 number'));
      const bound = (await deps.bindingsOf(sessionId)).find((b) => b.repo.toLowerCase() === (a.repo as string).toLowerCase());
      if (!bound) return err(forbidden(`仓库 ${a.repo} 没有绑给你（Bot 页的 GitHub 触发里才有）`));
      const token = await deps.tokenFor(bound.projectId);
      if (!token) return err(forbidden('这个项目的团队还没配 GitHub token'));
      try {
        if (name === 'github.comment') {
          if (typeof a.body !== 'string' || !a.body.trim()) return err(invalid('评论不能是空的'));
          return ok(await deps.client.comment(token, bound.repo, a.number, a.body.slice(0, 8000)));
        }
        if (!REACTIONS.includes(a.content as Reaction)) return err(invalid(`content 只能是 ${REACTIONS.join(' / ')}`));
        if (typeof a.commentId === 'number') await deps.client.reactComment(token, bound.repo, a.commentId, a.content as Reaction);
        else await deps.client.react(token, bound.repo, a.number, a.content as Reaction);
        return ok({ reacted: a.content });
      } catch (e) {
        return err(invalid(e instanceof Error ? e.message : String(e)));
      }
    }
  };
}
