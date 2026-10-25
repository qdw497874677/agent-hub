import { useCallback, useEffect, useRef, useState } from 'react';
import { api, streamUrl, type JournalEntryDto, type SessionDto } from './api.ts';
import { applyFrame, catchUp, seedLive, type Frame, type LiveMap } from './live-core.ts';

export * from './live-core.ts';

/** 连接状态：手机切后台、换网络时 SSE 会断，界面要说出来，而不是安静地停更。 */
export type StreamState = 'connecting' | 'open' | 'reconnecting';

export interface LiveStream {
  readonly live: LiveMap;
  readonly state: StreamState;
  /** 用画布投影里的历史给内存播种：一条会话只播一次，之后只吃比它新的帧。 */
  readonly seed: (sessions: readonly SessionDto[], previews: Readonly<Record<string, readonly JournalEntryDto[]>>) => void;
}

const MAX_BACKOFF_MS = 15_000;

/**
 * SSE 一条连接推所有会话；前端按 sessionId 分流。
 * 断了就退避重连；重连成功后按每条会话的 lastSeq 用 `events?after=` 补上断线期间的帧。
 * 用原生 EventSource 而不是 SSE 库：它的自动重连 + 这里的补帧已经够用，不值得多一个依赖。
 */
export function useLiveStream(onResync?: () => void): LiveStream {
  const [live, setLive] = useState<LiveMap>({});
  const [state, setState] = useState<StreamState>('connecting');
  const liveRef = useRef(live);
  liveRef.current = live;
  const resyncRef = useRef(onResync);
  resyncRef.current = onResync;

  const seed = useCallback(
    (sessions: readonly SessionDto[], previews: Readonly<Record<string, readonly JournalEntryDto[]>>) => {
      setLive((current) => seedLive(current, sessions, previews));
    },
    []
  );

  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;
    let everOpened = false;

    const resync = async (): Promise<void> => {
      const sessions = Object.entries(liveRef.current);
      await Promise.all(
        sessions.map(async ([sessionId, session]) => {
          const entries = await api.events(sessionId, session.lastSeq).catch(() => []);
          if (entries.length > 0) setLive((current) => catchUp(current, sessionId, entries));
        })
      );
      resyncRef.current?.();
    };

    const connect = (): void => {
      if (disposed) return;
      source = new EventSource(streamUrl());
      source.addEventListener('open', () => {
        attempt = 0;
        setState('open');
        if (everOpened) void resync();
        everOpened = true;
      });
      source.addEventListener('frame', (message) => {
        const frame = JSON.parse((message as MessageEvent<string>).data) as Frame;
        setLive((current) => applyFrame(current, frame));
      });
      source.addEventListener('error', () => {
        setState('reconnecting');
        // CONNECTING 说明浏览器自己在重连；CLOSED 才需要我们接手（比如 server 重启时回了非 200）。
        if (source?.readyState !== EventSource.CLOSED) return;
        source.close();
        const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(connect, delay);
      });
    };

    connect();
    // 手机从后台切回来时 EventSource 可能已经悄悄死了：可见时主动检查一次。
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible' || source?.readyState !== EventSource.CLOSED) return;
      clearTimeout(timer);
      attempt = 0;
      connect();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      source?.close();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return { live, state, seed };
}
