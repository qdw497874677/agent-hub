import type { SessionEventStream, SessionStreamFrame } from '@agent-hub/domain';

export interface StreamHub {
  readonly stream: SessionEventStream;
  subscribe(listener: (frame: SessionStreamFrame) => void): () => void;
}

/** 进程内广播。一个浏览器的 SSE 连接就是一个订阅者。 */
export function createStreamHub(): StreamHub {
  const listeners = new Set<(frame: SessionStreamFrame) => void>();

  return {
    stream: {
      publish(frame: SessionStreamFrame): void {
        for (const listener of listeners) listener(frame);
      },
      subscribe(listener: (frame: SessionStreamFrame) => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    },
    subscribe(listener: (frame: SessionStreamFrame) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
