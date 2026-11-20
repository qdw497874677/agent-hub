// misc 能力的处理函数（从 app.ts 原样搬出；鉴权/限流/审计仍在 app.ts 的前导里）。
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { V1Runtime } from '../context.ts';
import { openapiOn } from '../context.ts';
import type { Env } from '../context.ts';
import {
  isServiceAccount
} from '@agent-hub/domain';
import {
  routes
} from '.././routes.ts';
import {
  workbenchSkillManifest,
  workbenchSkillZip
} from '../../workbench-skill.ts';

/** installMisc：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installMisc(app: OpenAPIHono<Env>, _rt: V1Runtime): void {
  const on = openapiOn(app);
  on(routes.health, (c) => c.json({ ok: true }));
  on(routes.workbenchSkill, (c) => {
    if (c.req.query('format') === 'json') return c.json(workbenchSkillManifest());
    const zip = workbenchSkillZip();
    return new Response(Buffer.from(zip), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="agent-hub-workbench.zip"'
      }
    });
  });
}

/** installMe：注册顺序与拆分前一致（Hono 的路由匹配顺序敏感）。 */
export function installMe(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  const on = openapiOn(app);
  on(routes.me, (c) => {
    const actor = rt.principal(c);
    return c.json({
      user: { id: actor.user.id, name: actor.user.displayName, service: isServiceAccount(actor.user) },
      token: { id: actor.via!.tokenId, name: actor.via!.name, kind: actor.via!.kind }
    });
  });
}
