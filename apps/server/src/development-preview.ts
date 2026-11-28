import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '@agent-hub/domain';
import { isEmailVerified, previewUrl } from '@agent-hub/domain';
import type { PreviewChannel } from './preview-channel.ts';
import { createPreviewProxy } from './preview-proxy.ts';
import type { DevelopmentPreviewReservation, DevelopmentPreviewStore } from './development-preview-store.ts';

type PortRange = { readonly from: number; readonly to: number };
type Destination = Omit<DevelopmentPreviewReservation, 'hubPort'>;
type AccessProof = { readonly id: string; readonly login: string; readonly expires: number; readonly startPath: string };
const LAUNCH = '/.agent-hub-development-preview';
const MAX_PROOFS = 1024;

export function developmentStartPath(value: string): string | null {
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value, 'http://preview.invalid');
    return url.origin === 'http://preview.invalid' && !url.pathname.startsWith('//') && url.pathname !== LAUNCH ? url.pathname : null;
  } catch { return null; }
}

/** Release 1 supports only an explicitly provisioned, distinct local browser hostname. */
export function developmentPreviewRange(input: {
  readonly raw: string | null; readonly bind: string; readonly hubPort: number;
  readonly publicUrl: string | null; readonly legacy: PortRange | null;
}): PortRange | null {
  const match = /^(\d{4,5})(?:-(\d{4,5}))?$/.exec(input.raw ?? '');
  if (!match || input.bind !== '127.0.0.1' || !input.legacy) return null;
  if (input.publicUrl !== null) {
    try { if (new URL(input.publicUrl).origin !== `http://127.0.0.1:${input.hubPort}`) return null; }
    catch { return null; }
  }
  const from = Number(match[1]);
  const to = Number(match[2] ?? match[1]);
  if (from < 1024 || to > 65_535 || to < from || to - from >= 512) return null;
  if (input.hubPort >= from && input.hubPort <= to || from <= input.legacy.to && to >= input.legacy.from) return null;
  return { from, to };
}

function cookie(req: IncomingMessage, name: string): string | null {
  const values = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : null;
}

export function createDevelopmentPreview(options: {
  readonly range: PortRange;
  readonly hubPort: number;
  readonly store: DevelopmentPreviewStore;
  readonly channel: PreviewChannel;
  readonly authenticate: (login: string) => Promise<Principal | null>;
  readonly authorize: (actor: Principal, destination: Destination) => Promise<boolean>;
  readonly legacyPortInUse: (hubPort: number) => Promise<boolean>;
  readonly now: () => number;
  readonly onLog: (message: string) => void;
}) {
  const launchProofs = new Map<string, AccessProof>();
  const browserProofs = new Map<string, AccessProof>();
  const opening = new Map<string, Promise<void>>();
  const inRange = (port: number) => port >= options.range.from && port <= options.range.to;
  const cookieName = '__Host-ahub_dev';
  const hostFor = (port: number) => `dev-${port}.localhost`;
  const originOf = (port: number) => `http://${hostFor(port)}:${port}`;
  const hasExactHost = (req: IncomingMessage, port: number) => req.headers.host === `${hostFor(port)}:${port}`;
  const browserAllowed = (req: IncomingMessage, port: number) => {
    if (!hasExactHost(req, port)) return false;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== originOf(port)) return false;
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none' && !(site === 'cross-site' && req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document')) return false;
    if (req.headers.upgrade !== undefined || req.method !== 'GET' && req.method !== 'HEAD') return origin === originOf(port);
    return true;
  };
  const check = async (login: string, dest: Destination) => {
    const actor = await options.authenticate(login);
    return actor && actor.via === undefined && isEmailVerified(actor.user) && await options.authorize(actor, dest) ? actor : null;
  };
  const read = (proofs: Map<string, AccessProof>, key: string | null) => {
    if (key === null || !/^[A-Za-z0-9_-]{43}$/.test(key)) return null;
    const proof = proofs.get(key);
    if (!proof || proof.expires <= options.now()) { proofs.delete(key); return null; }
    return proof;
  };
  const add = (proofs: Map<string, AccessProof>, proof: AccessProof) => {
    for (const [key, value] of proofs) if (value.expires <= options.now()) proofs.delete(key);
    if (proofs.size >= MAX_PROOFS) return null;
    const token = randomBytes(32).toString('base64url');
    proofs.set(token, proof);
    return token;
  };
  const rejectLaunch = (response: ServerResponse) => {
    response.writeHead(404, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-type': 'text/plain; charset=utf-8' });
    response.end('打开链接已失效，请回到开发服务重新打开。');
  };
  const proxy = createPreviewProxy<DevelopmentPreviewReservation>({
    host: '127.0.0.1', exclusivePorts: true,
    channel: options.channel, onLog: options.onLog,
    resolve: async (hubPort) => inRange(hubPort) && !(await options.legacyPortInUse(hubPort)) ? options.store.byPort(hubPort) : null,
    // Percent-encoding or alternative paths are not a way to redeem a launch.
    beforeAuthorize: async (req, response, dest) => {
      if (req.url?.split('?')[0] !== LAUNCH) return;
      const match = /^\?key=([A-Za-z0-9_-]{43})$/.exec(req.url.slice(LAUNCH.length));
      const key = match?.[1] ?? null;
      const proof = read(launchProofs, key);
      if (req.method !== 'GET' || !hasExactHost(req, dest.hubPort) || !proof || !key || proof.id !== dest.id) return rejectLaunch(response);
      launchProofs.delete(key);
      if (!(await check(proof.login, dest))) return rejectLaunch(response);
      const duration = 30 * 60;
      const issued = add(browserProofs, { ...proof, expires: options.now() + duration * 1000 });
      if (!issued) return rejectLaunch(response);
      response.writeHead(303, { 'set-cookie': `${cookieName}=${issued}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${duration}`,
        location: proof.startPath, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      response.end();
    },
    authorize: async (req, dest) => {
      if (!browserAllowed(req, dest.hubPort)) return false;
      const proof = read(browserProofs, cookie(req, cookieName));
      return proof !== null && proof.id === dest.id && (await check(proof.login, dest)) !== null;
    },
    loginUrl: () => `http://127.0.0.1:${options.hubPort}/`,
  });
  return {
    canOpen: (workerId: string) => options.channel.supportsListenerIdentity?.(workerId) === true,
    async open(actor: Principal, login: string, dest: Destination, startPath = '/'): Promise<{ url: string | null; state: 'ready' | 'pending' } | null> {
      const path = developmentStartPath(startPath);
      if (path === null) return null;
      if (options.channel.supportsListenerIdentity?.(dest.workerId) !== true || (await check(login, dest))?.loginId !== actor.loginId) return null;
      const reserved = options.store.reserve(dest, options.range);
      if (!reserved || !inRange(reserved.hubPort) || await options.legacyPortInUse(reserved.hubPort)) return null;
      let binding = opening.get(reserved.id);
      if (!binding) {
        binding = proxy.listen(reserved).finally(() => opening.delete(reserved.id));
        opening.set(reserved.id, binding);
      }
      await binding;
      if (options.channel.supportsListenerIdentity?.(dest.workerId) !== true || (await check(login, dest))?.loginId !== actor.loginId) return null;
      if (!proxy.listening().some((link) => link.linkId === reserved.id && link.hubPort === reserved.hubPort)) return null;
      const key = add(launchProofs, { id: dest.id, login, expires: options.now() + 60_000, startPath: path });
      return key ? { state: 'ready', url: `${previewUrl(hostFor(reserved.hubPort), reserved.hubPort, false)}${LAUNCH.slice(1)}?key=${key}` } : null;
    },
    close: () => { launchProofs.clear(); browserProofs.clear(); return proxy.close(); },
  };
}
