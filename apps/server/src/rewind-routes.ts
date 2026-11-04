import type { Hono } from 'hono';
import { z } from 'zod';
import type { RewindService, Session, Subject } from '@agent-hub/domain';
import type { Context } from 'hono';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 回滚到某条消息（ADR 0027 阶段 4）：
 * - GET  /api/sessions/:id/rewind?promptSeq=N   这条消息的原文、能不能连文件回滚（不能时的原因）、会撤掉几轮
 * - POST /api/sessions/:id/rewind {promptSeq, files}  从这条消息之前分叉新会话；files=true 先把工作区恢复到这一轮开始前
 */
const Body = z.object({ promptSeq: z.number().int().positive(), files: z.boolean().default(false) });
const noStore = { 'cache-control': 'no-store' };

/** 回退出新会话后的回调（记来历，ADR 0031 D3）。 */
export type OnRewound = (c: Context, subject: Subject | null, session: Session, from: string, atSeq: number) => Promise<void>;

export function installRewindRoutes(app: Hono<any>, rewind: RewindService, subjectOf: SubjectOf, onRewound?: OnRewound): void {
  app.get('/api/sessions/:id/rewind', async (c) => {
    const seq = Number(c.req.query('promptSeq'));
    const r = await rewind.preview(subjectOf(c), c.req.param('id'), seq);
    return r.ok ? c.json(r.value, 200, noStore) : fail(c, r.error);
  });
  app.post('/api/sessions/:id/rewind', async (c) => {
    const body = Body.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: 'invalid', message: '参数不对' } }, 400);
    const subject = subjectOf(c);
    const r = await rewind.rewind(subject, c.req.param('id'), body.data.promptSeq, body.data.files);
    if (r.ok && onRewound) await onRewound(c, subject, r.value.session, c.req.param('id'), body.data.promptSeq).catch(() => undefined);
    return r.ok ? c.json(r.value, 201, noStore) : fail(c, r.error);
  });
}
