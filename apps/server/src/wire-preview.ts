import { timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import type { Schedules } from './schedules.ts';
import {
  authorizeSession,
  createPreviewLinkUseCase,
  markWorkerPreviewsOfflineUseCase,
  matchPreviewShare,
  parsePreviewPortRange,
  projectOfSession,
  systemSubject,
  type Deps,
  type EnrollmentDeps,
  type PreviewLink,
  type PreviewLinkId,
  type SessionId,
  type Subject
} from '@agent-hub/domain';
import type { SqliteStore } from '@agent-hub/storage-sqlite';
import { autoLinkCandidates, type WorkspaceOwner } from './preview-autolink.ts';
import { createPreviewChannel, type PreviewChannel } from './preview-channel.ts';
import { createPreviewProxy, type PreviewProxy } from './preview-proxy.ts';
import { createPreviewPrefix } from './preview-prefix.ts';
import { loginTokenOf } from './terminal-bridge.ts';

export interface PreviewWiringInput {
  readonly deps: Deps;
  readonly store: SqliteStore;
  readonly log: (message: string) => void;
  readonly readEnv: (name: string) => string | null;
  readonly host: string;
  readonly port: number;
  readonly spawnWorker: string;
  readonly localSecret: string;
  readonly enrollment: EnrollmentDeps['enrollment'];
  readonly tokens: EnrollmentDeps['tokens'];
  /** 浏览器登录 cookie → 主体；不认识的返回 null。 */
  readonly subjectOfCookie: (token: string) => Promise<Subject | null>;
  readonly now: () => number;
  readonly schedules: Schedules;
}

export interface PreviewWiring {
  readonly ports: { readonly from: number; readonly to: number } | null;
  readonly channel: PreviewChannel | null;
  readonly proxy: PreviewProxy | null;
  /** 启动时对齐一次端口，之后每 30 秒一次。 */
  start(): void;
  reconcile(): Promise<void>;
  /** 预览路径前缀模式（P4）；没启用时什么都不做。 */
  attachPrefix(app: Hono, prefixPath: string): void;
}

/**
 * 预览转发（docs/design/preview.md）：每一条预览链接在 hub 上占一个端口，
 * 浏览器访问那个端口时按帧转发给 worker 的 `/preview` 通道，再由 worker 打到本机回环端口。
 * `HUB_PREVIEW_PORTS` 为空串或 `0` 时整块关闭。
 */
export function wirePreviews(input: PreviewWiringInput): PreviewWiring {
  const { deps, store, log, readEnv, host, port, spawnWorker, localSecret, enrollment, tokens, subjectOfCookie, now, schedules } = input;
  const previewPorts = parsePreviewPortRange(readEnv('HUB_PREVIEW_PORTS'), port);
  let previewChannel: PreviewChannel | null = null;
  let previewProxy: PreviewProxy | null = null;
  const previewLog = (message: string) => log(`[preview] ${message}`);

  const authorizePreview = async (token: string, link: PreviewLink): Promise<boolean> => {
    if (token === '') return false;
    const subject = await subjectOfCookie(token);
    if (subject === null) return false;
    const session = await store.sessions.byId(link.sessionId);
    if (session === null) return false;
    const project = await projectOfSession({ tasks: store.tasks, projects: store.projects, bots: store.bots, workspaces: store.workspaces, workspaceGroups: store.workspaceGroups }, session);
    return (await authorizeSession(deps.access, subject, project, session, 'session.read')).ok;
  };

  if (previewPorts !== null) {
    const sameSecret = (given: string, expected: string): boolean => {
      const left = Buffer.from(given);
      const right = Buffer.from(expected);
      return left.length === right.length && timingSafeEqual(left, right);
    };
    previewChannel = createPreviewChannel({
      verifyWorker: async (request) => {
        const header = request.headers.authorization;
        if (typeof header === 'string' && header.startsWith('Bearer ')) {
          const credential = header.slice('Bearer '.length).trim();
          if (credential === '') return null;
          const found = await enrollment.credentialByHash(tokens.hashOf(credential));
          if (found === null || found.revokedAt !== null) return null;
          return { workerId: found.workerId };
        }
        // 本机 Worker 没有专属凭据：用它自报的 workerId + hub 生成的 localSecret。
        const secret = request.headers['x-hub-local-secret'];
        const workerId = request.headers['x-hub-worker-id'];
        if (spawnWorker !== '1' || typeof secret !== 'string' || typeof workerId !== 'string') return null;
        return sameSecret(secret, localSecret) ? { workerId } : null;
      },
      // P2：worker 每 10 秒报一次自己回环上在监听的端口，用来把链接标 ready / stale。
      onPorts: (workerId, ports) => {
        void (async () => {
          const listening = new Set(ports);
          const links = (await store.previewLinks.listAll()).filter((link) => link.workerId === workerId);
          let changed = 0;
          for (const link of links) {
            const wanted = listening.has(link.port);
            const state: PreviewLink['state'] = wanted ? 'ready' : link.state === 'offline' ? 'offline' : 'stale';
            if (state === link.state && !wanted) continue;
            await store.previewLinks.save({
              ...link,
              state,
              ...(wanted ? { lastSeenAt: now() } : {})
            });
            changed += 1;
          }
          if (changed > 0) previewLog(`端口状态更新：${changed} 条（${workerId}）`);
        })().catch((failure: unknown) => previewLog(`同步端口状态失败：${(failure as Error).message}`));
      },
      // P2：终端输出里认出端口就自动挂一条预览（幂等、上限与端口分配都走领域用例）。
      onDetected: (workerId, event) => {
        void (async () => {
          if (previewProxy === null || previewPorts === null) return;
          const created = await createPreviewLinkUseCase(
            {
              projects: deps.projects,
              tasks: deps.tasks,
              sessions: deps.sessions,
              workspaces: deps.workspaces,
              workspaceGroups: deps.workspaceGroups,
              access: deps.access,
              previewLinks: store.previewLinks,
              previewPorts,
              now
            },
            systemSubject('preview.detected'),
            { sessionId: event.sessionId, port: event.port, source: 'detected', ...(event.label === undefined ? {} : { label: event.label }) }
          );
          if (!created.ok) {
            // 「最多 8 条」「端口用完了」这类是正常上限，不打扰日志。
            if (created.error.code !== 'conflict') previewLog(`自动挂预览失败：${created.error.message}`);
            return;
          }
          if (created.value.workerId !== workerId) return;
          await previewProxy.listen(created.value);
          previewLog(`自动发现端口 ${created.value.port}（会话 ${event.sessionId.slice(0, 8)}）`);
        })().catch((failure: unknown) => previewLog(`自动挂预览失败：${(failure as Error).message}`));
      },
      onWorkerDown: (workerId) => {
        void markWorkerPreviewsOfflineUseCase({ previewLinks: store.previewLinks }, workerId)
          .then((changed) => {
            if (changed > 0) log(`${changed} 条预览链接随机器离线（${workerId}）`);
          })
          .catch((failure: unknown) => previewLog(`标记离线失败：${(failure as Error).message}`));
      },
      onLog: previewLog
    });
    // 预览端口上的 302 要跳回 hub 自己的登录页（预览 origin 上没有 SPA）。
    const hubOrigin =
      readEnv('HUB_PUBLIC_URL') ??
      `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}`;
    previewProxy = createPreviewProxy({
      resolve: (hubPort) => store.previewLinks.byHubPort(hubPort),
      loginUrl: (_request, _link, target) => `${hubOrigin}/login?next=${encodeURIComponent(target)}`,
      authorize: (request, link) => authorizePreview(loginTokenOf(request.headers.cookie), link),
      matchShare: (link, token) =>
        matchPreviewShare({ previewLinks: store.previewLinks }, link.id, token, now()).then(
          (result) => result.ok
        ),
      channel: previewChannel,
      host,
      onConflict: (linkId) => {
        void (async () => {
          const link = await store.previewLinks.byId(linkId as PreviewLinkId);
          if (link !== null && link.state !== 'stale') await store.previewLinks.save({ ...link, state: 'stale' });
        })().catch((failure: unknown) => previewLog(`端口冲突处理失败：${(failure as Error).message}`));
      },
      onLog: previewLog
    });
  }

  const autoDiscoverPreviews = async (): Promise<void> => {
    if (previewProxy === null || previewPorts === null) return;
    if (readEnv('HUB_PREVIEW_AUTO') === '0') return;
    const links = await store.previewLinks.listAll();
    const spaces = [...(await store.workspaces.temporaries()), ...(await store.workspaces.longLived())];
    const owners: WorkspaceOwner[] = [];
    const allowed = new Set<string>();
    const workerIds = new Set<string>();
    for (const space of spaces) {
      if (space.workerId === null) continue;
      for (const session of await store.sessions.listByWorkspace(space.id)) {
        if (session.status === 'failed') continue;
        if (session.workerId !== space.workerId) continue;
        owners.push({ sessionId: session.id, workerId: space.workerId, path: space.path });
        allowed.add(session.id);
        workerIds.add(space.workerId);
      }
    }
    if (owners.length === 0) {
      if (readEnv('HUB_PREVIEW_DEBUG') === '1') log(`预览自动发现：没有可挂的会话（空间 ${spaces.length} 个）`);
      return;
    }
    for (const workerId of workerIds) {
      const listed = await deps.gateway.processes?.(workerId);
      if (listed === undefined) {
        if (readEnv('HUB_PREVIEW_DEBUG') === '1') log('预览自动发现：网关没有提供进程清单');
        continue;
      }
      if (!listed.ok) {
        if (readEnv('HUB_PREVIEW_DEBUG') === '1') log(`预览自动发现：${workerId} 的进程清单拿不到：${listed.error.message}`);
        continue;
      }
      // 只拿这台机器上的会话工作空间去匹配：路径前缀跨机器没有意义。
      const workerOwners = owners.filter((entry) => entry.workerId === workerId);
      if (readEnv('HUB_PREVIEW_DEBUG') === '1') log(`预览自动发现：${workerId} ${listed.value.length} 个进程，会话 ${workerOwners.length} 条`);
      const candidates = autoLinkCandidates(
        workerId,
        listed.value.map((process) => ({ pid: process.pid, cwd: process.cwd, ports: process.ports })),
        workerOwners,
        { links, allowedSessions: allowed }
      );
      for (const candidate of candidates) {
        const created = await createPreviewLinkUseCase(
          {
            projects: deps.projects,
            tasks: deps.tasks,
            sessions: deps.sessions,
            workspaces: deps.workspaces,
            workspaceGroups: deps.workspaceGroups,
            access: deps.access,
            previewLinks: store.previewLinks,
            previewPorts,
            now
          },
          systemSubject('preview.detected'),
          { sessionId: candidate.sessionId as SessionId, port: candidate.port, source: 'detected' }
        );
        if (!created.ok) {
          if (created.error.code !== 'conflict') log(`按进程自动挂预览失败：${created.error.message}`);
          continue;
        }
        await previewProxy.listen(created.value);
        log(`按进程自动挂了预览：${candidate.sessionId} 端口 ${candidate.port}`);
      }
    }
  };

  /** 预览端口和库里的链接对齐：新加的开监听、删掉的关掉。启动时一次，之后每 30 秒一次。 */
  const reconcile = async (): Promise<void> => {
    if (previewProxy === null) return;
    await autoDiscoverPreviews().catch((failure: unknown) => log(`自动发现预览失败：${(failure as Error).message}`));
    const links = await store.previewLinks.listAll();
    const wanted = new Set<string>(links.map((link) => link.id));
    for (const listening of previewProxy.listening()) {
      if (!wanted.has(listening.linkId)) await previewProxy.unlisten(listening.linkId as PreviewLinkId);
    }
    const active = new Set(previewProxy.listening().map((entry) => entry.linkId));
    for (const link of links) {
      if (!active.has(link.id)) await previewProxy.listen(link);
    }
  };

  return {
    ports: previewPorts,
    get channel() { return previewChannel; },
    get proxy() { return previewProxy; },
    reconcile,
    start() {
      if (previewProxy === null) return;
      void reconcile().catch((failure: unknown) => log(`预览端口对齐失败：${(failure as Error).message}`));
      schedules.every(30_000, () => {
        void reconcile().catch((failure: unknown) => log(`预览端口对齐失败：${(failure as Error).message}`));
      });
    },
    attachPrefix(app: Hono, prefixPath: string) {
      const path = prefixPath.trim().replace(/\/+$/, '');
      if (path === '' || path === '/' || previewChannel === null) return;
      const prefixChannel = previewChannel;
      const previewPrefix = createPreviewPrefix({
        prefix: path,
        resolve: async (linkId) => store.previewLinks.byId(linkId as PreviewLinkId),
        authorize: async (request, link) => {
          const shared = new URL(request.url).searchParams.get('share');
          if (shared !== null && shared !== '') {
            const matched = await matchPreviewShare(
              { previewLinks: store.previewLinks },
              link.id,
              shared,
              now()
            );
            if (matched.ok) return true;
          }
          return authorizePreview(loginTokenOf(request.headers.get('cookie') ?? ''), link);
        },
        channel: prefixChannel,
        onLog: (message) => log(`[preview] ${message}`)
      });
      app.all(`${path}/*`, async (c) => (await previewPrefix.handle(c.req.raw)) ?? c.notFound());
      log(`预览路径前缀模式：${path}/<链接 id>/（不支持 WebSocket / HMR）`);
      // 前缀模式和 hub 同源：预览页里的脚本能读到 hub_csrf，等于拿到了以用户身份发请求的能力。
      // 只建议在「预览的就是自己写的页面」时开启。
      log('注意：前缀模式与 Hub 同源，预览页脚本能读到 hub_csrf');
    }
  };
}
