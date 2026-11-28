import { bodyLimit } from 'hono/body-limit';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { conflict, isEmailVerified, notFound, unavailable } from '@agent-hub/domain';
import type { Principal } from '@agent-hub/domain';
import type { createDevelopmentServices, DevelopmentServiceSelection } from './development-services.ts';
import { developmentStartPath, type createDevelopmentPreview } from './development-preview.ts';
import { fail } from './http-error.ts';
import { loginTokenOf } from './terminal-bridge.ts';

const prefix = '/api/development-services';
const id = z.string().min(1).max(2048);
const component = z.string().min(1).max(256);
const manualInput = z.strictObject({ workerId: component, workspaceId: component, port: z.number().int().min(1024).max(65535), startPath: z.string().max(1024).default('/') });
export interface DevelopmentServicesRoutes {
  readonly directory: ReturnType<typeof createDevelopmentServices>;
  readonly preview: ReturnType<typeof createDevelopmentPreview> | null;
  readonly hubPort: number;
}

export function installDevelopmentServicesRoutes(app: Hono, options: DevelopmentServicesRoutes | undefined, principalOf: (c: Context) => Principal | null): void {
  const actorOf = (c: Context) => {
    const actor = principalOf(c);
    return actor && actor.via === undefined && isEmailVerified(actor.user) ? actor : null;
  };
  const project = (record: DevelopmentServiceSelection) => ({ id: record.id, name: record.name, port: record.port, workerId: record.workerId, workspaceId: record.workspaceId, openable: record.openable });
  const unavailableHere = (c: Context) => fail(c, unavailable('当前入口不支持打开开发服务。'));
  const notAvailable = (c: Context) => fail(c, notFound('开发服务不存在或已停止。'));
  const bounded = bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: { code: 'invalid', message: '请求太长。' } }, 413) });
  function launchAllowed(c: Context): boolean {
    // Different host from the dev page; do not serve a localhost launch to a remote browser.
    const host = `127.0.0.1:${options?.hubPort}`;
    return !!options?.preview && c.req.header('host') === host && c.req.header('origin') === `http://${host}`
      && new URL(c.req.url).protocol === 'http:' && c.req.header('x-forwarded-host') === undefined && c.req.header('x-forwarded-proto') === undefined;
  }
  app.get(prefix, async (c) => {
    const actor = actorOf(c);
    return options && actor ? c.json({ workers: await options.directory.workers(actor) }) : notAvailable(c);
  });
  app.get(`${prefix}/workers/:id`, async (c) => {
    const actor = actorOf(c);
    if (!options || !actor) return notAvailable(c);
    const result = await options.directory.worker(actor, c.req.param('id'));
    // Keep discovery available over remote entrances; only loopback may advertise opening.
    const local = c.req.header('host') === `127.0.0.1:${options.hubPort}` && new URL(c.req.url).protocol === 'http:' && c.req.header('x-forwarded-proto') === undefined && c.req.header('x-forwarded-host') === undefined;
    return result ? c.json({ ...result, manualAvailable: local && options.preview !== null, groups: result.groups.map((group) => ({ ...group, services: group.services.map((item) => ({ ...item, openable: local && item.openable })) })) }) : notAvailable(c);
  });
  app.get(`${prefix}/services/:id`, async (c) => {
    const actor = actorOf(c);
    if (!options || !actor) return notAvailable(c);
    const selected = await options.directory.service(actor, c.req.param('id'));
    const local = c.req.header('host') === `127.0.0.1:${options.hubPort}` && new URL(c.req.url).protocol === 'http:' && c.req.header('x-forwarded-proto') === undefined && c.req.header('x-forwarded-host') === undefined;
    return selected ? c.json({ service: { ...project(selected), openable: local && selected.openable } }) : notAvailable(c);
  });
  app.post(`${prefix}/open`, bounded, async (c) => {
    const actor = actorOf(c);
    if (!options || !actor) return notAvailable(c);
    if (!launchAllowed(c) || !options.preview) return unavailableHere(c);
    const parsed = z.strictObject({ id }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'invalid', message: '请求体不合法。' } }, 400);
    const selected = await options.directory.selectOpen(actor, parsed.data.id);
    if (!selected) return notAvailable(c);
    const result = await options.preview.open(actor, loginTokenOf(c.req.header('cookie')), selected);
    return result ? c.json(result) : fail(c, conflict('无法确认开发服务入口，请刷新列表。'));
  });
  app.post(`${prefix}/manual`, bounded, async (c) => {
    const actor = actorOf(c);
    if (!options || !actor) return notAvailable(c);
    if (!launchAllowed(c) || !options.preview) return unavailableHere(c);
    const parsed = manualInput.safeParse(await c.req.json().catch(() => null));
    const path = parsed.success ? developmentStartPath(parsed.data.startPath) : null;
    if (!parsed.success || path === null) return c.json({ error: { code: 'invalid', message: '请填写 1024–65535 的端口和以 / 开头的页面路径。' } }, 400);
    const selected = await options.directory.manual(actor, parsed.data);
    if (!selected) return notAvailable(c);
    const result = await options.preview.open(actor, loginTokenOf(c.req.header('cookie')), selected, path);
    return result ? c.json(result) : fail(c, conflict('无法确认开发服务入口，请刷新列表。'));
  });
}
