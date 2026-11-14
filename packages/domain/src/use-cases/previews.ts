import type { Subject } from '../access.ts';
import { conflict, invalid, notFound, type DomainError } from '../errors.ts';
import { asSessionId, newId, type PreviewLinkId } from '../ids.ts';
import {
  PREVIEW_LINKS_MAX,
  previewLabelOf,
  previewLinkIdFrom,
  previewPortProblem,
  type PreviewLink,
} from '../preview.ts';
import type { PreviewLinkRepository } from '../ports/preview-links.ts';
import { err, ok, type Result } from '../result.ts';
import { terminalTarget, type TerminalTargetDeps } from './terminal.ts';

/**
 * 预览链接的依赖（docs/design/preview.md §4/§9）。
 *
 * `previewPorts` 是 hub 侧能 listen 的端口区间（`HUB_PREVIEW_PORTS`），`previewPortFree`
 * 用来躲开区间里被别的进程占住的端口。代理层真正 bind 之前还会再查一次，所以这里
 * 允许不传。
 */
export type PreviewDeps = TerminalTargetDeps & {
  readonly previewLinks: PreviewLinkRepository;
  readonly previewPorts: { readonly from: number; readonly to: number };
  readonly previewPortFree?: (port: number) => boolean;
  readonly now: () => number;
};

export interface CreatePreviewCommand {
  readonly sessionId: string;
  /** 被预览的端口，指 worker 上那个进程监听的 loopback 端口。 */
  readonly port: number;
  readonly label?: string;
  /** 默认 `manual`；P2 的输出探测会把 `detected` 传进来。 */
  readonly source?: PreviewLink['source'];
}

const freshLinkId = async (repo: PreviewLinkRepository): Promise<PreviewLinkId> => {
  // pv_ + 8 位十六进制，撞了再摇；真摇不出来就交给唯一约束报错。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = previewLinkIdFrom(newId().replaceAll('-', '').slice(0, 8));
    if ((await repo.byId(id)) === null) return id;
  }
  return previewLinkIdFrom(newId().replaceAll('-', '').slice(0, 8));
};

/**
 * 给会话挂一条预览链接。同一会话 + 同一端口重复建是幂等的，直接返回已有那条，
 * 这样前端刷新/重试不会把区间吃满。
 */
export async function createPreviewLinkUseCase(
  deps: PreviewDeps,
  subject: Subject | null,
  command: CreatePreviewCommand,
): Promise<Result<PreviewLink, DomainError>> {
  const target = await terminalTarget(deps, subject, command.sessionId);
  if (!target.ok) return target;

  const problem = previewPortProblem(command.port);
  if (problem !== null) return err(invalid(problem));

  const sessionId = asSessionId(command.sessionId);
  const links = await deps.previewLinks.listBySession(sessionId);
  const existing = links.find((link) => link.port === command.port);
  if (existing !== undefined) return ok(existing);

  if (links.length >= PREVIEW_LINKS_MAX) {
    return err(conflict(`一个会话最多 ${PREVIEW_LINKS_MAX} 条预览`));
  }

  const used = new Set((await deps.previewLinks.listAll()).map((link) => link.hubPort));
  let hubPort: number | null = null;
  for (let port = deps.previewPorts.from; port <= deps.previewPorts.to; port += 1) {
    if (used.has(port)) continue;
    if (deps.previewPortFree?.(port) === false) continue;
    hubPort = port;
    break;
  }
  if (hubPort === null) return err(conflict('预览端口用完了，删掉一条再试'));

  const at = deps.now();
  const link: PreviewLink = {
    id: await freshLinkId(deps.previewLinks),
    sessionId,
    workerId: target.value.workerId ?? 'local',
    port: command.port,
    hubPort,
    label: previewLabelOf(command.label, command.port),
    source: command.source ?? 'manual',
    state: 'ready',
    createdAt: at,
    lastSeenAt: at,
  };
  await deps.previewLinks.save(link);
  return ok(link);
}

/** 列某个会话的预览链接（鉴权走 `session.read`），按创建时间升序。 */
export async function listPreviewLinksUseCase(
  deps: PreviewDeps,
  subject: Subject | null,
  sessionId: string,
): Promise<Result<readonly PreviewLink[], DomainError>> {
  const target = await terminalTarget(deps, subject, sessionId);
  if (!target.ok) return target;

  const links = await deps.previewLinks.listBySession(asSessionId(sessionId));
  return ok([...links].sort((a, b) => a.createdAt - b.createdAt));
}

/** 删一条预览链接；必须属于 `sessionId`，否则当不存在处理（不泄露别人的链接）。 */
export async function removePreviewLinkUseCase(
  deps: PreviewDeps,
  subject: Subject | null,
  sessionId: string,
  linkId: string,
): Promise<Result<void, DomainError>> {
  const target = await terminalTarget(deps, subject, sessionId);
  if (!target.ok) return target;

  const link = await deps.previewLinks.byId(linkId as PreviewLinkId);
  if (link === null || link.sessionId !== sessionId) return err(notFound('预览链接不存在'));
  await deps.previewLinks.remove(link.id);
  return ok(undefined);
}

/**
 * worker 掉线时把它名下的预览全部标 `offline`（代理层据此回 502，而不是让人干等）。
 * 返回被改动的条数。
 */
export async function markWorkerPreviewsOfflineUseCase(
  deps: Pick<PreviewDeps, 'previewLinks'>,
  workerId: string,
): Promise<number> {
  let changed = 0;
  for (const link of await deps.previewLinks.listAll()) {
    if (link.workerId !== workerId || link.state === 'offline') continue;
    await deps.previewLinks.save({ ...link, state: 'offline' });
    changed += 1;
  }
  return changed;
}
