import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { FileChangeNotice, WorkspaceFilesService } from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 工作空间文件浏览（ADR 0025 · P1，只读）：
 * - GET /api/sessions/:id/files/context            根目录、所在机器、会话开始时的 HEAD
 * - GET /api/sessions/:id/files?path=               列一层目录（灰显被忽略的，.git 不列）
 * - GET /api/sessions/:id/files/content?path=&confirm=1   预览（≤1 MB，base64），敏感文件要 confirm 并记审计
 * - GET /api/sessions/:id/files/download?path=&confirm=1  下载单个文件（≤20 MB）
 * - GET /api/sessions/:id/files/find?q=             模糊找文件（≤50 条）
 * - GET /api/sessions/:id/git/changes?base=session|head
 * - GET /api/sessions/:id/git/diff?path=&base=
 * - GET /api/sessions/:id/files/events?paths=a,b    SSE：这些目录 / 文件变了就推 {paths, reset?}
 * 会话可见性由 installAccess（session.read）把关，workspace.files.read 在用例里判。Worker 不在线 → 503，不缓存。
 */
const baseOf = (raw: string | undefined) => (raw === 'head' ? 'head' : 'session');
const noStore = { 'cache-control': 'no-store' };

export function installFilesRoutes(app: Hono<any>, files: WorkspaceFilesService, subjectOf: SubjectOf): void {
  const sid = (c: { req: { param(k: string): string } }) => c.req.param('id');
  app.get('/api/sessions/:id/files/context', async (c) => {
    const r = await files.context(subjectOf(c), sid(c));
    return r.ok ? c.json(r.value, 200, noStore) : fail(c, r.error);
  });
  app.get('/api/sessions/:id/files', async (c) => {
    const r = await files.list(subjectOf(c), sid(c), c.req.query('path') ?? '');
    return r.ok ? c.json(r.value, 200, noStore) : fail(c, r.error);
  });
  app.get('/api/sessions/:id/files/content', async (c) => {
    const r = await files.read(subjectOf(c), sid(c), c.req.query('path') ?? '', c.req.query('confirm') === '1');
    if (!r.ok) return fail(c, r.error);
    const { bytes, ...meta } = r.value;
    return c.json({ ...meta, data: Buffer.from(bytes).toString('base64') }, 200, noStore);
  });
  app.get('/api/sessions/:id/files/download', async (c) => {
    const r = await files.download(subjectOf(c), sid(c), c.req.query('path') ?? '', c.req.query('confirm') === '1');
    if (!r.ok) return fail(c, r.error);
    const name = r.value.path.split('/').pop() || 'file';
    return new Response(r.value.bytes, {
      headers: {
        ...noStore,
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'x-content-type-options': 'nosniff'
      }
    });
  });
  app.get('/api/sessions/:id/files/find', async (c) => {
    const r = await files.find(subjectOf(c), sid(c), c.req.query('q') ?? '');
    return r.ok ? c.json({ files: r.value }, 200, noStore) : fail(c, r.error);
  });
  app.get('/api/sessions/:id/git/changes', async (c) => {
    const r = await files.changes(subjectOf(c), sid(c), baseOf(c.req.query('base')));
    return r.ok ? c.json(r.value, 200, noStore) : fail(c, r.error);
  });
  app.get('/api/sessions/:id/git/diff', async (c) => {
    const r = await files.diff(subjectOf(c), sid(c), c.req.query('path') ?? '', baseOf(c.req.query('base')));
    return r.ok ? c.json(r.value, 200, noStore) : fail(c, r.error);
  });
  app.get('/api/sessions/:id/files/events', async (c) => {
    const raw = c.req.query('paths') ?? '';
    const paths = raw === '' ? [''] : raw.split(',').map((p) => decodeURIComponent(p));
    const queue: FileChangeNotice[] = [];
    let wake: (() => void) | null = null;
    const watched = await files.watch(subjectOf(c), sid(c), paths, (notice) => {
      queue.push(notice);
      wake?.();
    });
    if (!watched.ok) return fail(c, watched.error);
    const stop = watched.value;
    return streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
        wake?.();
      });
      await stream.writeSSE({ event: 'ready', data: '{}' });
      try {
        while (open) {
          const notice = queue.shift();
          if (notice) {
            await stream.writeSSE({ event: 'changed', data: JSON.stringify(notice) });
            if (notice.reset) break; // Worker 掉线：让浏览器自己重连重订
            continue;
          }
          await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(25_000)]);
          wake = null;
          if (open && queue.length === 0) await stream.writeSSE({ event: 'ping', data: '' });
        }
      } finally {
        stop();
      }
    });
  });
}
