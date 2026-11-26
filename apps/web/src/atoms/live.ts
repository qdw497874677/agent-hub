import { useCallback, useEffect, useRef, useState } from 'react';
import { api, streamUrl, type JournalEntryDto, type SessionDto } from '../shell/api.ts';
import type { Frame, LiveMap } from './live-core.ts';
import { LiveSync } from './live-sync.ts';

export * from './live-core.ts';

export type StreamState = 'connecting' | 'open' | 'reconnecting';
export type HistoryState = 'loading' | 'loaded' | 'error';

export interface LiveStream {
  readonly live: LiveMap;
  readonly state: StreamState;
  readonly history: Readonly<Record<string, HistoryState>>;
  readonly sync: Readonly<Record<string, 'syncing' | 'stale'>>;
  readonly retrySync: (sessionId: string) => void;
  readonly seed: (sessions: readonly SessionDto[], previews: Readonly<Record<string, readonly JournalEntryDto[]>>) => void;
  readonly loadHistory: (session: SessionDto) => Promise<void>;
}

const MAX_BACKOFF_MS = 15_000;

/** One SSE connection, with independent per-session transcript freshness. */
export function useLiveStream(onResync?: () => void): LiveStream {
  const [live, setLive] = useState<LiveMap>({});
  const [state, setState] = useState<StreamState>('connecting');
  const [history, setHistory] = useState<Readonly<Record<string, HistoryState>>>({});
  const [sync, setSync] = useState<Readonly<Record<string, 'syncing' | 'stale'>>>({});
  const coordinator = useRef<LiveSync | null>(null);
  if (!coordinator.current) coordinator.current = new LiveSync(api.events, (next, freshness, histories) => {
    setLive(next);
    setSync(freshness);
    setHistory(histories);
  });
  const resyncRef = useRef(onResync);
  resyncRef.current = onResync;

  const seed = useCallback((sessions: readonly SessionDto[], previews: Readonly<Record<string, readonly JournalEntryDto[]>>) => {
    coordinator.current?.seed(sessions, previews);
  }, []);
  const loadHistory = useCallback((session: SessionDto) => coordinator.current!.loadHistory(session), []);
  const retrySync = useCallback((sessionId: string) => coordinator.current?.retrySync(sessionId), []);

  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;
    let everOpened = false;
    const syncer = coordinator.current!;

    const connect = (): void => {
      if (disposed) return;
      const current = new EventSource(streamUrl());
      source = current;
      current.addEventListener('open', () => {
        if (disposed || source !== current) return;
        attempt = 0;
        setState('open');
        syncer.open();
        if (everOpened) resyncRef.current?.();
        everOpened = true;
      });
      current.addEventListener('frame', (message) => {
        if (disposed || source !== current) return;
        syncer.frame(JSON.parse((message as MessageEvent<string>).data) as Frame);
      });
      current.addEventListener('error', () => {
        if (disposed || source !== current) return;
        setState('reconnecting');
        syncer.disconnect();
        if (current.readyState !== EventSource.CLOSED) return;
        current.close();
        const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(connect, delay);
      });
    };

    connect();
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
      syncer.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return { live, state, seed, loadHistory, history, sync, retrySync };
}
