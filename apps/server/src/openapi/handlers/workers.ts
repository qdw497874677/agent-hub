// workers 能力的处理函数（从 app.ts 原样搬出；鉴权/限流/审计仍在 app.ts 的前导里）。
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { V1Runtime } from '../context.ts';
import { openapiOn, valid } from '../context.ts';
import type { Env } from '../context.ts';
import {
  can,
  forbidden,
  listWorkers,
  capabilityStatus,
  installBuiltinBrowser,
  installWorkerComponent,
  workerReader,
  redactInventory
} from '@agent-hub/domain';
import type {
  WorkerStatus
} from '@agent-hub/domain';
import { fail } from '../../http-error.ts';
import {
  routes
} from '.././routes.ts';
import {
  attachHubModelsToWorker,
  collectSessionModels
} from '.././session-models.ts';

/** installWorkers：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installWorkers(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  const on = openapiOn(app);
  on(routes.listWorkers, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'worker.read')) return fail(c, forbidden('令牌没有 workers:read'));
    const readable = await workerReader(rt.deps.access, actor);
    const workers = [];
    const collected = await collectSessionModels({
      actor,
      workers: await listWorkers(rt.deps),
      readable,
      providers: rt.providers?.deps
    });
    // 开放 API 是集成面：不出套件清单、外部组件的包名 / 来源串（ADR 0021 §7），只留能力
    for (const worker of collected.workers) workers.push(redactInventory(attachHubModelsToWorker(worker, collected.hub)));
    return c.json(workers);
  });
  on(routes.listModels, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'worker.read')) return fail(c, forbidden('令牌没有 workers:read'));
    const readable = await workerReader(rt.deps.access, actor);
    const query = valid<{ workerId?: string; agentId?: string }>(c, 'query');
    const collected = await collectSessionModels({
      actor,
      workers: await listWorkers(rt.deps),
      readable,
      providers: rt.providers?.deps,
      workerId: query.workerId,
      agentId: query.agentId
    });
    return c.json({ models: collected.models });
  });
  on(routes.workerBrowserStatus, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'worker.read')) return fail(c, forbidden('令牌没有 workers:read'));
    if (!rt.components) return fail(c, { code: 'not_implemented', message: '这个 hub 没开组件安装' });
    const readable = await workerReader(rt.deps.access, actor);
    const workers: WorkerStatus[] = [];
    for (const w of await rt.components.workers.list()) if (await readable(w.workerId)) workers.push(w);
    // 本来就只出能力视图（redactInventory 同款约束）：blocker / installJob 不含包名、来源串
    return c.json(capabilityStatus(workers, 'browser:chromium'));
  });
  on(routes.capabilityStatus, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'worker.read')) return fail(c, forbidden('令牌没有 workers:read'));
    if (!rt.components) return fail(c, { code: 'not_implemented', message: '这个 hub 没开组件安装' });
    const query = valid<{ capability?: string; workerId?: string }>(c, 'query');
    const readable = await workerReader(rt.deps.access, actor);
    const workers: WorkerStatus[] = [];
    for (const w of await rt.components.workers.list()) {
      if (query.workerId && w.workerId !== query.workerId) continue;
      if (await readable(w.workerId)) workers.push(w);
    }
    return c.json(capabilityStatus(workers, query.capability));
  });
  on(routes.installBuiltinBrowser, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'worker.read')) return fail(c, forbidden('令牌没有 workers:read'));
    if (!rt.components) return fail(c, { code: 'not_implemented', message: '这个 hub 没开组件安装' });
    const workerId = c.req.param('workerId') ?? '';
    const started = await installBuiltinBrowser(rt.components, actor, workerId);
    if (!started.ok) return fail(c, started.error);
    const { jobId, agentId, action, state, message } = started.value;
    return c.json({ jobId, agentId, action, state, message }, 202);
  });
  on(routes.installWorkerComponent, async (c) => {
    const actor = rt.principal(c);
    if (!can(actor, 'worker.read')) return fail(c, forbidden('令牌没有 workers:read'));
    if (!rt.components) return fail(c, { code: 'not_implemented', message: '这个 hub 没开组件安装' });
    const workerId = c.req.param('workerId') ?? '';
    const body = valid<{ componentId?: string; version?: string; capability?: string }>(c, 'json');
    const started = await installWorkerComponent(rt.components, actor, { workerId, ...body });
    if (!started.ok) return fail(c, started.error);
    const { jobId, agentId, action, state, message } = started.value;
    return c.json({ jobId, agentId, action, state, message }, 202);
  });
}
