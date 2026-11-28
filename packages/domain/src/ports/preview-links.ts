import type { PreviewLink } from '../preview.ts';
import type { PreviewLinkId, SessionId, WorkspaceId } from '../ids.ts';

/** 预览链接的持久化（`preview_links` 表）。 */
export interface PreviewLinkRepository {
  byId(id: PreviewLinkId): Promise<PreviewLink | null>;
  byHubPort(hubPort: number): Promise<PreviewLink | null>;
  listBySession(sessionId: SessionId): Promise<readonly PreviewLink[]>;
  /** 启动时用：确认端口区间里哪些已经被占。 */
  listAll(): Promise<readonly PreviewLink[]>;
  save(link: PreviewLink): Promise<void>;
  /** Atomic conditional insert for verified direct-workspace workflow registrations. */
  insertIfCurrentWorkspace?(link: PreviewLink, expected: { readonly workspaceId: WorkspaceId; readonly workerId: string; readonly root: string }): Promise<boolean>;
  remove(id: PreviewLinkId): Promise<void>;
  removeBySession(sessionId: SessionId): Promise<void>;
}
