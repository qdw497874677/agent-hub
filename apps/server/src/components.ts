import type { Hono } from 'hono';
import { bundleInstallRequest, componentJobRequest, componentReviewRequest, componentSubmitRequest } from '@agent-hub/contract';
import type { ComponentDeps, NpmArtifactInfo } from '@agent-hub/domain';
import { installScriptsOf, listComponentCatalog, reviewComponent, startBundleJob, startComponentJob, submitComponent } from '@agent-hub/domain';
import type { PrincipalOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * hub 去 registry 查一个确切版本的元数据（paseo 的做法：审核前先解析制品，审的就是装的）。
 * 只读公开元数据；registry 地址可配（HUB_NPM_REGISTRY，测试指向本地假 registry）。
 */
export function createNpmResolver(registry: string, fetchImpl: typeof fetch = fetch): (name: string, version: string) => Promise<NpmArtifactInfo> {
  const base = registry.replace(/\/+$/, '');
  return async (name, version) => {
    const path = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
    const response = await fetchImpl(`${base}/${path}/${encodeURIComponent(version)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`registry 返回 ${response.status}`);
    const body = (await response.json()) as { name?: unknown; version?: unknown; dist?: { tarball?: unknown; integrity?: unknown }; scripts?: unknown; dependencies?: unknown };
    return {
      name: typeof body.name === 'string' ? body.name : '',
      version: typeof body.version === 'string' ? body.version : '',
      resolved: typeof body.dist?.tarball === 'string' ? body.dist.tarball : '',
      integrity: typeof body.dist?.integrity === 'string' ? body.dist.integrity : '',
      scripts: installScriptsOf(body.scripts),
      dependencyCount: typeof body.dependencies === 'object' && body.dependencies !== null ? Object.keys(body.dependencies).length : 0
    };
  };
}

export function installComponents(app: Hono, deps: ComponentDeps, principalOf: PrincipalOf): void {
  const unauthorized = { error: { code: 'unauthorized', message: '请先登录' } } as const;
  app.get('/api/components', async (c) => {
    const principal = principalOf(c);
    if (!principal) return c.json(unauthorized, 401);
    const result = await listComponentCatalog(deps, principal);
    return result.ok ? c.json({ components: result.value }) : fail(c, result.error);
  });
  app.post('/api/components', async (c) => {
    const principal = principalOf(c);
    if (!principal) return c.json(unauthorized, 401);
    const parsed = componentSubmitRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'invalid', message: '请求格式不对：id、npm 包名、确切版本（X.Y.Z）' } }, 400);
    const result = await submitComponent(deps, principal, {
      id: parsed.data.id,
      packageName: parsed.data.packageName,
      version: parsed.data.version,
      provides: parsed.data.provides.map((p) => ({ capability: p.capability, ...(p.mode ? { mode: p.mode } : {}) })),
      runtime: parsed.data.runtime,
      ...(parsed.data.git ? { git: parsed.data.git } : {})
    });
    return result.ok ? c.json({ component: result.value }, 201) : fail(c, result.error);
  });
  app.post('/api/components/:id/:version/review', async (c) => {
    const principal = principalOf(c);
    if (!principal) return c.json(unauthorized, 401);
    const parsed = componentReviewRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'invalid', message: '请求格式不对：{ approve, note? }' } }, 400);
    const result = await reviewComponent(deps, principal, c.req.param('id'), c.req.param('version'), {
      approve: parsed.data.approve,
      ...(parsed.data.note ? { note: parsed.data.note } : {})
    });
    return result.ok ? c.json({ component: result.value }) : fail(c, result.error);
  });
  app.post('/api/workers/:id/bundle-install', async (c) => {
    const principal = principalOf(c);
    if (!principal) return c.json(unauthorized, 401);
    const parsed = bundleInstallRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'invalid', message: '请求格式不对：components 是 [{ componentId, version }]（1–16 个）' } }, 400);
    const result = await startBundleJob(deps, principal, c.req.param('id'), { components: parsed.data.components });
    return result.ok ? c.json({ job: result.value }, 202) : fail(c, result.error);
  });
  app.post('/api/workers/:id/components/:componentId', async (c) => {
    const principal = principalOf(c);
    if (!principal) return c.json(unauthorized, 401);
    const parsed = componentJobRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'invalid', message: '请求格式不对：action 只能是 install / uninstall' } }, 400);
    const result = await startComponentJob(deps, principal, c.req.param('id'), {
      componentId: c.req.param('componentId'),
      action: parsed.data.action === 'install' ? 'install_component' : 'uninstall_component',
      ...(parsed.data.version ? { version: parsed.data.version } : {})
    });
    return result.ok ? c.json({ job: result.value }, 202) : fail(c, result.error);
  });
}
