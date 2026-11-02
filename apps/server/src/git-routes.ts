import type { Hono } from 'hono';
import { z } from 'zod';
import type { GitWorkflowService } from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 提交 / 推送 / PR（ADR 0027 阶段 2）：
 * - GET  /api/sessions/:id/git/state       分支、远端、改动、能不能推送 / 开 PR、任务上的 PR
 * - POST /api/sessions/:id/git/draft       提炼模型（或模板）写的提交说明、PR 标题 / 描述、分支名建议
 * - POST /api/sessions/:id/git/run         {action: commit|push|pr, message, title?, body?}
 * - GET  /api/tasks/:id/pull-requests      任务上的 PR（打开时顺手同步开着的）
 * - GET / PUT / DELETE /api/git-host/token 团队 GitHub token：只回 configured + 末 4 位
 */
const RunBody = z.object({
  action: z.enum(['commit', 'push', 'pr']),
  message: z.string().max(8000).default(''),
  title: z.string().max(300).optional(),
  body: z.string().max(65_536).optional()
});
const noStore = { 'cache-control': 'no-store' };

export function installGitRoutes(app: Hono<any>, git: GitWorkflowService, subjectOf: SubjectOf): void {
  app.get('/api/sessions/:id/git/state', async (c) => {
    const r = await git.state(subjectOf(c), c.req.param('id'));
    return r.ok ? c.json(r.value, 200, noStore) : fail(c, r.error);
  });
  app.post('/api/sessions/:id/git/draft', async (c) => {
    const r = await git.draft(subjectOf(c), c.req.param('id'));
    return r.ok ? c.json(r.value, 200, noStore) : fail(c, r.error);
  });
  app.post('/api/sessions/:id/git/run', async (c) => {
    const body = RunBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: 'invalid', message: '参数不对' } }, 400);
    const r = await git.run(subjectOf(c), c.req.param('id'), { action: body.data.action, message: body.data.message, ...(body.data.title !== undefined ? { title: body.data.title } : {}), ...(body.data.body !== undefined ? { body: body.data.body } : {}) });
    return r.ok ? c.json(r.value, 200, noStore) : fail(c, r.error);
  });
  app.get('/api/tasks/:id/pull-requests', async (c) => {
    const r = await git.syncTask(subjectOf(c), c.req.param('id'));
    return r.ok ? c.json({ pullRequests: r.value }, 200, noStore) : fail(c, r.error);
  });
  app.get('/api/git-host/token', async (c) => {
    const r = await git.tokenStatus(subjectOf(c));
    return r.ok ? c.json(r.value, 200, noStore) : fail(c, r.error);
  });
  app.put('/api/git-host/token', async (c) => {
    const body = z.object({ token: z.string().min(1).max(300) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: 'invalid', message: '缺 token' } }, 400);
    const r = await git.setToken(subjectOf(c), body.data.token);
    return r.ok ? c.json(r.value, 200, noStore) : fail(c, r.error);
  });
  app.delete('/api/git-host/token', async (c) => {
    const r = await git.removeToken(subjectOf(c));
    return r.ok ? c.json(r.value, 200, noStore) : fail(c, r.error);
  });
}
