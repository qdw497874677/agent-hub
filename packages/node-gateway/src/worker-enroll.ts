import { hostname, platform, arch } from 'node:os';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, serverToWorkerSchema, type WorkerToServer } from '@agent-hub/contract';

export type EnrollOutcome =
  | { readonly ok: true; readonly workerId: string; readonly credential: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 接入握手的 worker 端（WS 适配器）：连 /worker，第一帧发 enroll（配对码），等 `enrolled` 拿专属凭据。
 * hub 校验完会关掉这条连接；之后 worker 用凭据正常 hello。码和凭据都不进日志。
 */
export function enrollOverLink(options: {
  readonly url: string;
  readonly code: string;
  readonly label: string;
  readonly timeoutMs?: number;
}): Promise<EnrollOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (outcome: EnrollOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
      socket.close();
    };
    const socket = new WebSocket(options.url);
    const timer = setTimeout(() => done({ ok: false, reason: 'hub 没有及时回应接入' }), options.timeoutMs ?? 15_000);
    socket.on('open', () => {
      const frame: WorkerToServer = {
        type: 'enroll',
        code: options.code,
        label: options.label,
        host: { hostname: hostname(), platform: platform(), arch: arch() },
        protocol: PROTOCOL_VERSION
      };
      socket.send(JSON.stringify(frame));
    });
    socket.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        return;
      }
      const parsed = serverToWorkerSchema.safeParse(raw);
      if (parsed.success && parsed.data.kind === 'enrolled') {
        done({ ok: true, workerId: parsed.data.workerId, credential: parsed.data.credential });
      }
    });
    socket.on('close', (code, reason) => done({ ok: false, reason: String(reason) || `连接被关闭（${code}）` }));
    socket.on('error', (error) => done({ ok: false, reason: `连不上 hub：${error.message}` }));
  });
}
