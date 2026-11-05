import type { OutputSink, OutputSinkEvent } from '@agent-hub/domain';
import type { GithubClient } from './client.ts';
import { parseIssueKey } from './rules.ts';

export interface GithubSinkDeps {
  readonly client: GithubClient;
  /** 项目绑定的 token（任务所在项目 → 团队 token）。 */
  readonly tokenFor: (projectId: string) => Promise<string | null>;
  /** 这个项目下 github Binding 绑定的仓库：只往这些仓库回帖（externalId 是 bot 填的，不能信）。 */
  readonly boundRepos: (projectId: string) => Promise<readonly string[]>;
  readonly prLinks: (taskId: string) => Promise<readonly string[]>;
  readonly log?: (line: string) => void;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 回程：开工的 👀 由入站那边贴；这里管完成回 PR 链接、失败回原因。 */
export function createGithubSink(deps: GithubSinkDeps): OutputSink {
  return {
    id: 'github',
    async deliver(e: OutputSinkEvent) {
      if (e.kind === 'task.created' || !e.projectId) return;
      const at = parseIssueKey(e.externalId);
      if (!at) return;
      if (!(await deps.boundRepos(e.projectId)).includes(at.repo)) { deps.log?.(`[github] ${at.repo} 没绑在这个项目上，不回帖`); return; }
      const token = await deps.tokenFor(e.projectId);
      if (!token) { deps.log?.('[github] 没有 token，不回帖'); return; }
      let body: string;
      if (e.kind === 'task.finished') {
        const links = e.taskId ? await deps.prLinks(e.taskId) : [];
        body = links.length ? `✅ 已完成，PR：\n${links.map((l) => `- ${l}`).join('\n')}` : `✅ 已完成（没有开 PR）。\n\n> ${clip(e.detail, 1500).split('\n').join('\n> ')}`;
      } else {
        body = `❌ 没做成：\n\n> ${clip(e.detail || '（没有原因）', 1500).split('\n').join('\n> ')}`;
      }
      await deps.client.comment(token, at.repo, at.number, `${body}\n\n<sub>agent-hub</sub>`).catch((err) => deps.log?.(`[github] 回帖失败 ${e.externalId}：${String(err?.message ?? err)}`));
    }
  };
}
