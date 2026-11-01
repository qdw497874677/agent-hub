import type { Context, Hono } from 'hono';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { InstallArtifacts } from './install-artifacts.ts';
import type { PairingDto } from '@agent-hub/contract';
import type { EnrollmentDeps } from '@agent-hub/domain';
import { issuePairingCode, revokeWorker } from '@agent-hub/domain';
import type { PrincipalOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 单台机器接入的 HTTP 外壳（docs/design/worker-enrollment.md）：
 * - `POST /api/workers/pairing`：登录的人签发接入码，拿到一行安装命令；
 * - 配对码兑换凭据**不在这里**：走 /worker 长连接的 enroll 握手（worker-enroll.ts）；
 * - `DELETE /api/workers/:id`：吊销一台机器（domain 判权限）；
 * - `GET /install-worker.sh`：给新机器 curl 的引导脚本，hub 地址和提交号由这里填好。
 */
export interface EnrollmentOptions {
  readonly deps: EnrollmentDeps;
  /** 引导脚本模板（scripts/bootstrap-worker.sh）。 */
  readonly bootstrapScript: string;
  /** hub 当前的提交：新机器 checkout 到它，版本天然一致。 */
  readonly commit: string | null;
  /** 从 hub 直接下代码（不经 GitHub）：GET /install/worker-<提交>.{tar.gz,bundle}[.sha256]。 */
  readonly artifacts?: InstallArtifacts;
}


/** 外面看到的 hub 地址：反代给了 x-forwarded-proto 就用它。 */
export function publicOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '');
  return `${proto}://${c.req.header('host') ?? url.host}`;
}

/** 只放进单引号里的值：hub 地址来自 Host 头，不能让它在 shell 里变成命令。 */
const shellSafe = (value: string): boolean => /^[A-Za-z0-9._:/\-[\]]+$/.test(value);

export function installEnrollment(app: Hono, options: EnrollmentOptions, principalOf: PrincipalOf): void {
  const { deps } = options;

  app.post('/api/workers/pairing', async (c) => {
    const result = await issuePairingCode(deps, principalOf(c));
    if (!result.ok) return fail(c, result.error);
    const hubUrl = publicOrigin(c);
    const body: PairingDto = {
      code: result.value.code,
      expiresAt: result.value.expiresAt,
      hubUrl,
      command: `curl -fsSL ${hubUrl}/install-worker.sh | HUB_PAIR=${result.value.code} bash`
    };
    c.header('cache-control', 'no-store');
    return c.json(body);
  });

  app.delete('/api/workers/:id', async (c) => {
    const principal = principalOf(c);
    if (!principal) return c.json({ error: { code: 'unauthorized', message: '请先登录' } }, 401);
    const result = await revokeWorker(deps, principal, c.req.param('id'));
    return result.ok ? c.json({ workerId: result.value.workerId, revokedAt: result.value.revokedAt }) : fail(c, result.error);
  });

  app.get('/install-worker.sh', async (c) => {
    const origin = publicOrigin(c);
    if (!shellSafe(origin)) return c.text('Host 不合法', 400);
    const template = await readFile(options.bootstrapScript, 'utf8');
    const script = template
      .replaceAll('__HUB_HTTP__', origin)
      .replaceAll('__HUB_COMMIT__', options.commit && /^[0-9a-f]{7,40}$/.test(options.commit) ? options.commit : '');
    return c.body(script, 200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' });
  });

  // 代码包：和 install-worker.sh 一样不要登录（内容就是公开仓库里的那个提交，不含任何配置 / 数据）
  app.get('/install/:name', async (c) => {
    const artifacts = options.artifacts;
    const match = /^worker(?:-([0-9a-f]{40}))?\.(tar\.gz|bundle)(\.sha256)?$/.exec(c.req.param('name'));
    if (!artifacts?.commit || !match) return c.text('没有这个安装包', 404);
    const [, commit, kind, checksum] = match as unknown as [string, string | undefined, 'tar.gz' | 'bundle', string | undefined];
    if (commit && commit !== artifacts.commit) return c.text(`hub 只提供它正在跑的提交 ${artifacts.commit}`, 404);
    const artifact = await artifacts.get(kind);
    if (!artifact) return c.text('安装包生成失败（hub 不是从 git 仓库运行？）', 503);
    const file = `worker-${artifacts.commit}.${kind}`;
    if (checksum) return c.text(`${artifact.sha256}  ${file}\n`, 200, { 'cache-control': 'no-store' });
    return c.body(Readable.toWeb(createReadStream(artifact.path)) as ReadableStream, 200, {
      'content-type': kind === 'bundle' ? 'application/x-git-bundle' : 'application/gzip',
      'content-length': String(artifact.size),
      'content-disposition': `attachment; filename="${file}"`,
      'x-agent-hub-commit': artifacts.commit,
      'x-agent-hub-sha256': artifact.sha256,
      'cache-control': commit ? 'public, max-age=86400, immutable' : 'no-store'
    });
  });
}
