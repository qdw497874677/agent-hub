import type { ConnectorBinding, InboundContext, InboundSource } from '@agent-hub/domain';
import { untrusted } from '@agent-hub/domain';
import type { GithubClient } from './client.ts';
import { GITHUB_MAX_COMMENTS_PER_POLL, GITHUB_MAX_ISSUES_PER_POLL, clipText, detectInjection, githubParams, isWriterPermission, issueKey, lastLabeler, mentions, validateGithubParams } from './rules.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export interface GithubSourceDeps {
  readonly client: GithubClient;
  /** 项目绑定的 token（Binding 的项目 → 团队 token）；没配是 null。只在内存里用，不落日志。 */
  readonly tokenFor: (binding: ConnectorBinding) => Promise<string | null>;
  /** PR 是哪条会话开的（跟进评论回到那条会话）；不是 hub 开的 PR 是 null。 */
  readonly sessionForPr: (repo: string, number: number) => Promise<string | null>;
  readonly log?: (line: string) => void;
  readonly intervalMs?: number;
}

const note = (key: string) =>
  `（GitHub issue ${key}，贴标签的人有写权限。要动手就用 task.create 建任务，并带 source {connector: "github", externalId: "${key}"}；完成后 hub 会把 PR 链接回帖到 issue。）`;

/** 一次轮询（导出给测试）：只认 label 由写权限的人贴上的 issue；PR 上 @bot 的写权限评论回到原会话。 */
export async function githubPoll(ctx: InboundContext, deps: GithubSourceDeps, cursors: Map<string, number>, b: ConnectorBinding): Promise<void> {
  const { repo, label } = githubParams(b.params);
  const token = await deps.tokenFor(b);
  if (!token) throw new Error('这个项目的团队还没配 GitHub token');
  const writer = new Map<string, boolean>();
  const isWriter = async (login: string) => {
    if (!writer.has(login)) writer.set(login, isWriterPermission(await deps.client.permission(token, repo, login)));
    return writer.get(login)!;
  };

  // 1) 带标签的 issue
  let looked = 0;
  for (const issue of await deps.client.labeledIssues(token, repo, label)) {
    if (looked >= GITHUB_MAX_ISSUES_PER_POLL) break;
    const key = issueKey(repo, issue.number);
    const labeler = lastLabeler(await deps.client.issueEvents(token, repo, issue.number), label);
    looked++;
    if (!labeler) continue;
    // 去重键带上贴标签那次事件：没权限的人贴的记一次跳过；之后写权限的人重新贴，是新事件，会再看
    const ext = `${key}@${labeler.eventId}`;
    if (await ctx.seen(b.id, ext)) continue;
    if (!(await isWriter(labeler.login))) { await ctx.skip(b.id, { externalId: ext }, `标签是 @${labeler.login} 贴的，他没有写权限，不处理`); continue; }
    const text = `# ${issue.title}\n\n${issue.body ?? ''}`;
    const hit = detectInjection(text);
    if (hit) { await ctx.skip(b.id, { externalId: ext }, `疑似注入（${hit}），已隔离，没交给 bot：${issue.html_url}`); continue; }
    await ctx.emit(b.id, { kind: 'issue', externalId: ext, title: issue.title, text: untrusted(clipText(text)), url: issue.html_url, note: note(key) });
    if (await ctx.seen(b.id, ext)) {
      await deps.client.react(token, repo, issue.number, 'eyes').catch((e) => deps.log?.(`[github] 👀 失败 ${key}：${String(e?.message ?? e)}`));
    }
    break; // 一次只交一个：上一个没结束前，核心也不会再收
  }

  // 2) PR 跟进：只认写权限的人 @bot，且 PR 还开着、是 hub 开的
  const since = cursors.get(b.id) ?? Math.max(b.createdAt, ctx.now() - 7 * DAY);
  const comments = await deps.client.commentsSince(token, repo, new Date(since).toISOString());
  let login: string | null = null;
  let n = 0;
  for (const c of comments) {
    cursors.set(b.id, Math.max(cursors.get(b.id) ?? since, Date.parse(c.created_at) || since));
    if (n >= GITHUB_MAX_COMMENTS_PER_POLL) break;
    const m = /\/pull\/(\d+)/.exec(c.html_url);
    if (!m || !c.user?.login) continue;
    login ??= await deps.client.viewer(token);
    if (c.user.login === login || !mentions(c.body, login)) continue;
    const ext = `${repo}#${m[1]}/comment/${c.id}`;
    if (await ctx.seen(b.id, ext)) continue;
    n++;
    const pr = Number(m[1]);
    const sessionId = await deps.sessionForPr(repo, pr);
    if (!sessionId) continue;
    if (!(await isWriter(c.user.login))) continue;
    if ((await deps.client.pullState(token, repo, pr)) !== 'open') continue;
    const hit = detectInjection(c.body);
    if (hit) { await ctx.skip(b.id, { externalId: ext }, `疑似注入（${hit}），已隔离，没交给 bot：${c.html_url}`); continue; }
    await ctx.emit(b.id, {
      kind: 'pr.comment', externalId: ext, title: `PR #${pr} 的跟进`, text: untrusted(clipText(c.body)), url: c.html_url, targetSessionId: sessionId,
      note: `（@${c.user.login} 在你开的 PR ${repo}#${pr} 上 @ 了你，他有写权限。按评论改完推到同一分支；要回复用 github.comment。）`
    });
    if (await ctx.seen(b.id, ext)) await deps.client.reactComment(token, repo, c.id, 'eyes').catch(() => undefined);
  }
}

export function createGithubSource(deps: GithubSourceDeps): InboundSource {
  const cursors = new Map<string, number>();
  const tick = async (ctx: InboundContext) => {
    const now = ctx.now();
    for (const b of await ctx.bindings()) {
      if (!b.enabled || b.pausedReason) continue;
      const period = githubParams(b.params).everyMin * MIN;
      if (b.nextRunAt === null) { await ctx.advance(b.id, null, now); continue; }
      if (now < b.nextRunAt) continue;
      if (!(await ctx.advance(b.id, b.nextRunAt, now + period))) continue;
      await githubPoll(ctx, deps, cursors, b).catch(async (e) => {
        const reason = String(e?.message ?? e).slice(0, 300);
        deps.log?.(`[github] 轮询 ${githubParams(b.params).repo} 失败：${reason}`);
        // 每天最多记一条，让 Bot 页的「上次」能看到为什么没动静
        await ctx.skip(b.id, { externalId: `error:${Math.floor(now / DAY)}` }, `轮询失败：${reason}`).catch(() => undefined);
      });
    }
  };
  return {
    id: 'github',
    kinds: ['issue'],
    validate: validateGithubParams,
    describe: (b) => { const p = githubParams(b.params); return `${p.repo} · 标签 ${p.label} · 每 ${p.everyMin} 分钟`; },
    // 任务在别的会话里做，bot 这一轮只是分派；按 1 小时算超时
    periodMs: () => 60 * MIN,
    start(ctx) {
      let busy = false;
      const run = () => {
        if (busy) return;
        busy = true;
        tick(ctx).catch((e) => console.error('[github] tick 失败', e)).finally(() => { busy = false; });
      };
      const handle = setInterval(run, deps.intervalMs ?? 30_000);
      handle.unref?.();
      run();
      return { stop: () => clearInterval(handle) };
    }
  };
}
