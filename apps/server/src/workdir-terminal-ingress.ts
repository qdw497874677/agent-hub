import { createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { IssuedLogin } from '@agent-hub/domain';
import { sameSecret } from './request-guard.ts';

export const WORKDIR_TERMINAL_LOGIN_COOKIE = '__Host-hub_terminal_login';
const PROXY_HEADER = 'x-hub-workdir-proxy-proof';
const LOOPBACK = new Set(['127.0.0.1', '::1']);

export function workdirTerminalAdminOrigin(input: {
  origin: string | null; bind: string; uid: number | undefined; spawnWorker: string; previewPrefix: string | null; proxyProof: string | null;
}): URL | null {
  if (!input.origin || !LOOPBACK.has(input.bind) || !input.uid || input.spawnWorker !== '0' || input.previewPrefix || !/^[a-f0-9]{64}$/.test(input.proxyProof ?? '')) return null;
  try {
    const url = new URL(input.origin);
    return url.protocol === 'https:' && url.origin === input.origin ? url : null;
  } catch { return null; }
}

/** Strict forwarding contract for a dedicated HTTPS upgrade proxy. The proxy must overwrite XFP. */
export function createWorkdirTerminalIngress(origin: URL, proxyProof: string, now: () => number) {
  const key = randomBytes(32);
  const sign = (token: string, expiry: string) => createHmac('sha256', key).update(`${expiry}:${token}`).digest('base64url');
  const connection = (peer: string | undefined, host: string | undefined, forwarded: string | string[] | undefined, proof: string | string[] | undefined) =>
    LOOPBACK.has((peer ?? '').replace(/^::ffff:/, '')) && host === origin.host && forwarded === 'https' && typeof proof === 'string' && sameSecret(proof, proxyProof);
  const http = (c: Context) => {
    try {
      if (!connection(getConnInfo(c).remote.address, c.req.header('host'), c.req.header('x-forwarded-proto'), c.req.header(PROXY_HEADER))) return false;
      const declared = c.req.header('origin');
      return declared === origin.origin || (declared === undefined && /^(GET|HEAD)$/.test(c.req.method));
    } catch { return false; }
  };
  const token = (header: string | undefined): string => {
    const cookies = (header ?? '').split(';').map((part) => part.trim());
    const unique = (name: string) => {
      const values = cookies.filter((part) => part.startsWith(`${name}=`));
      return values.length === 1 ? values[0]!.slice(name.length + 1) : '';
    };
    const login = unique('__Host-hub_login');
    const proof = unique(WORKDIR_TERMINAL_LOGIN_COOKIE).match(/^(\d{1,16})\.([\w-]{43})$/);
    if (!login || !proof?.[1] || !proof[2] || Number(proof[1]) <= now()) return '';
    return sameSecret(proof[2], sign(login, proof[1])) ? login : '';
  };
  const worker = (req: IncomingMessage) => connection(req.socket.remoteAddress, req.headers.host, req.headers['x-forwarded-proto'], req.headers[PROXY_HEADER]);
  return {
    issue(c: Context, login: IssuedLogin) {
      if (!http(c)) return;
      const expiry = String(login.expiresAt);
      setCookie(c, WORKDIR_TERMINAL_LOGIN_COOKIE, `${expiry}.${sign(login.token, expiry)}`, {
        path: '/', secure: true, httpOnly: true, sameSite: 'Strict', maxAge: Math.max(0, Math.floor((login.expiresAt - now()) / 1_000))
      });
    },
    token(c: Context) { return http(c) ? token(c.req.header('cookie')) : ''; },
    socketToken(req: IncomingMessage) {
      return worker(req) && req.headers.origin === origin.origin ? token(req.headers.cookie) : '';
    },
    worker
  };
}
