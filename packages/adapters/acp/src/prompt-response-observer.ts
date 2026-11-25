import type { ndJsonStream } from '@agentclientprotocol/sdk';

type Stream = ReturnType<typeof ndJsonStream>;
type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Observes the SDK's decoded stream, retaining only one request id and a verdict. */
export class PromptResponseObserver {
  private current: { id: string | number | null | undefined; seen: boolean; proven: boolean } | null = null;

  begin(): object {
    const observation = { id: undefined, seen: false, proven: false };
    this.current = observation;
    return observation;
  }

  proven(observation: object): boolean {
    return this.current === observation && this.current.proven;
  }

  end(observation: object): void {
    if (this.current === observation) this.current = null;
  }

  wrap(stream: Stream): Stream {
    const writer = stream.writable.getWriter();
    return {
      writable: new WritableStream({
        write: (message) => {
          const current = this.current;
          if (current && current.id === undefined && 'method' in message && message.method === 'session/prompt' && 'id' in message) {
            const id = message.id;
            if (typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)) || id === null) current.id = id;
          }
          return writer.write(message);
        },
        close: () => writer.close(),
        abort: (reason) => writer.abort(reason)
      }),
      readable: stream.readable.pipeThrough(new TransformStream({
        transform: (message, controller) => {
          // A batch is not the single response observed on OpenCode's wire. Still
          // poison matching members so a later duplicate cannot become evidence.
          if (Array.isArray(message)) {
            for (const member of message) this.observe(member, false);
          } else this.observe(message, true);
          controller.enqueue(message);
        }
      }))
    };
  }

  private observe(message: unknown, single: boolean): void {
    const current = this.current;
    if (!current || current.id === undefined || current.seen || !record(message) || message['id'] !== current.id) return;
    // A valid reverse request can reuse the ID; malformed method-bearing
    // frames are ambiguous and poison any later duplicate response.
    if (message['jsonrpc'] === '2.0' && typeof message['method'] === 'string' &&
      (!('params' in message) || record(message['params']) || Array.isArray(message['params'])) &&
      !('result' in message) && !('error' in message)) return;
    current.seen = true;
    const error = message['error'];
    current.proven = single && message['jsonrpc'] === '2.0' && !('method' in message) && !Object.hasOwn(message, 'result') &&
      Object.hasOwn(message, 'error') && record(error) && error['code'] === -32603 &&
      typeof error['message'] === 'string' && record(error['data']) && error['data']['errorName'] === 'provider.invalid-request';
  }
}
