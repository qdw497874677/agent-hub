import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CanvasDto, SessionDto } from '../shell/api.ts';
import { api, sessionsApi } from '../shell/api.ts';
import { projectKeys } from '../shell/query-keys.ts';
import { dropSession, normalizeSessionTitle, patchSession } from './session-actions.ts';

/**
 * 会话操作的请求和缓存改写：会话页 / 画布窗口的「⋯」和侧栏行菜单共用这一份。
 * 每个动作失败就抛出原错误，忙碌态和错误怎么显示由调用方决定。
 */
export interface SessionActions {
  /** 改名：和原名一样就不发请求，返回 false。 */
  readonly rename: (session: SessionDto, raw: string) => Promise<boolean>;
  /** 从最新处分叉，返回新会话。 */
  readonly fork: (session: SessionDto) => Promise<SessionDto>;
  readonly setSettled: (session: SessionDto, next: boolean) => Promise<void>;
  /** 常驻：先就地改缓存（卡片小图钉立刻反应），失败翻回原值再抛。 */
  readonly setPinned: (session: SessionDto, next: boolean) => Promise<void>;
  /** 服务端已经删掉之后：把会话和它的连线从画布缓存里摘掉。 */
  readonly forget: (sessionId: string) => void;
}

export function useSessionActions(projectId: string): SessionActions {
  const queries = useQueryClient();
  return useMemo(() => {
    const canvasKey = projectKeys.canvas(projectId);
    const patch = (sessionId: string, change: Partial<SessionDto>): void => {
      queries.setQueryData<CanvasDto>(canvasKey, (current) => (current ? patchSession(current, sessionId, change) : current));
      // 侧聊这类不进画布的会话：单条查询是它唯一的缓存。
      queries.setQueryData<SessionDto>(['session', sessionId], (current) => (current === undefined ? current : { ...current, ...change }));
    };
    return {
      async rename(session, raw) {
        const next = normalizeSessionTitle(raw);
        if (next === (session.title ?? '')) return false;
        const updated = await api.renameSession(session.id, next);
        patch(session.id, { title: updated.title } as Partial<SessionDto>);
        return true;
      },
      fork: (session) => api.fork({ sessionId: session.id, agentId: session.agentId, model: session.model }),
      async setSettled(session, next) {
        const updated = await api.settleSession(session.id, next);
        patch(session.id, { settledAt: next ? (updated.settledAt ?? Date.now()) : null } as Partial<SessionDto>);
        void queries.invalidateQueries({ queryKey: ['home'] });
        void queries.invalidateQueries({ queryKey: ['session', session.id] });
      },
      async setPinned(session, next) {
        const before = session.pinned === true;
        patch(session.id, { pinned: next } as Partial<SessionDto>);
        try {
          const updated = await sessionsApi.pin(session.id, next);
          patch(session.id, { pinned: updated.pinned === true } as Partial<SessionDto>);
        } catch (failure) {
          patch(session.id, { pinned: before } as Partial<SessionDto>);
          throw failure;
        }
      },
      forget(sessionId) {
        queries.setQueryData<CanvasDto>(canvasKey, (current) => (current ? dropSession(current, sessionId) : current));
      }
    };
  }, [queries, projectId]);
}
