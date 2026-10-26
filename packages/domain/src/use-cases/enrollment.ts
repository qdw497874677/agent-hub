import { randomUUID } from 'node:crypto';
import type { AuditEntry, HubSettings, Principal } from '../account.ts';
import { canAddMachines } from '../account.ts';
import { CREDENTIAL_PREFIX, PAIRING_PREFIX, PAIRING_TTL_MS } from '../enrollment.ts';
import type { WorkerCredential } from '../enrollment.ts';
import { conflict, forbidden, invalid, notFound } from '../errors.ts';
import type { DomainError } from '../errors.ts';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { EnrollmentRepository } from '../ports/enrollment-repository.ts';
import type { SettingsRepository } from '../ports/settings-repository.ts';
import type { TokenIssuer } from '../ports/token-issuer.ts';
import type { UserRepository } from '../ports/user-repository.ts';
import type { WorkerControl } from '../ports/worker-control.ts';

/**
 * 单台机器接入的用例（docs/design/worker-enrollment.md）。
 * 规则都在这里：谁能签发、码怎么兑换、凭据怎么认、谁能吊销；HTTP 和 WebSocket 只是外壳。
 */
export interface EnrollmentDeps {
  readonly enrollment: EnrollmentRepository;
  readonly tokens: TokenIssuer;
  readonly settings: Pick<SettingsRepository, 'get'>;
  readonly users: Pick<UserRepository, 'byId'>;
  readonly audit: AuditLog;
  readonly workers: Pick<WorkerControl, 'list' | 'disconnect'>;
  readonly now: () => number;
  /** 新机器的 workerId；默认 `remote-<8 位>`。 */
  readonly newWorkerId?: () => string;
}

export interface IssuedPairing {
  readonly code: string;
  readonly expiresAt: number;
}

export interface Enrolled {
  readonly workerId: string;
  readonly credential: string;
}

async function audit(
  deps: Pick<EnrollmentDeps, 'audit' | 'now'>,
  actor: { readonly id: string; readonly email: string },
  action: AuditEntry['action'],
  target: string,
  detail: string
): Promise<void> {
  await deps.audit.append({
    id: randomUUID(),
    actorId: actor.id as AuditEntry['actorId'],
    actorEmail: actor.email,
    action,
    target,
    detail,
    at: deps.now()
  });
}

const allowedToAdd = (principal: Principal | null, settings: HubSettings): principal is Principal =>
  principal !== null && principal.user.disabledAt === null && canAddMachines(principal.user, settings);

/** 「添加机器」：签发一个 15 分钟、一次性的 Pairing Code。明文只在这次返回里出现。 */
export async function issuePairingCode(
  deps: EnrollmentDeps,
  principal: Principal | null
): Promise<Result<IssuedPairing, DomainError>> {
  if (!allowedToAdd(principal, await deps.settings.get())) return err(forbidden('你没有添加机器的权限，请联系主人'));
  const { token } = deps.tokens.issue();
  const code = `${PAIRING_PREFIX}${token}`;
  const createdAt = deps.now();
  const expiresAt = createdAt + PAIRING_TTL_MS;
  await deps.enrollment.savePairing({
    hash: deps.tokens.hashOf(code),
    createdBy: principal.user.id,
    createdAt,
    expiresAt,
    usedAt: null,
    workerId: null
  });
  await audit(deps, principal.user, 'worker.pair', 'pairing', `有效至 ${new Date(expiresAt).toISOString()}`);
  return ok({ code, expiresAt });
}

const cleanLabel = (label: string | undefined): string => {
  const trimmed = (label ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64);
  return trimmed === '' ? '新机器' : trimmed;
};

/**
 * Worker 拿 Pairing Code 换长期凭据。码作废（并发兑换只有一个成功）、新发一个 workerId，
 * 凭据只存哈希、绑定这个 workerId。错误一律同一句话：不告诉对方是过期了还是用过了还是根本不存在。
 */
export async function enrollWorker(
  deps: EnrollmentDeps,
  input: { readonly code: string; readonly label?: string }
): Promise<Result<Enrolled, DomainError>> {
  const rejected = err(invalid('接入码无效或已过期，请在「机器」页重新生成'));
  if (!input.code.startsWith(PAIRING_PREFIX)) return rejected;
  const hash = deps.tokens.hashOf(input.code);
  const pairing = await deps.enrollment.pairingByHash(hash);
  const now = deps.now();
  if (!pairing || pairing.usedAt !== null || pairing.expiresAt <= now) return rejected;
  const creator = await deps.users.byId(pairing.createdBy);
  if (!creator || creator.disabledAt !== null) return rejected;

  const workerId = deps.newWorkerId?.() ?? `remote-${randomUUID().slice(0, 8)}`;
  if (!(await deps.enrollment.consumePairing(hash, workerId, now))) return rejected;

  const { token } = deps.tokens.issue();
  const credential = `${CREDENTIAL_PREFIX}${token}`;
  const label = cleanLabel(input.label);
  await deps.enrollment.saveCredential({
    workerId,
    tokenHash: deps.tokens.hashOf(credential),
    enrolledBy: creator.id,
    label,
    createdAt: now,
    revokedAt: null
  });
  await audit(deps, creator, 'worker.enroll', `${label}（${workerId}）`, '凭接入码');
  return ok({ workerId, credential });
}

export type WorkerAuth =
  | { readonly ok: true; readonly via: 'credential' | 'shared' }
  | { readonly ok: false; readonly reason: string };

/**
 * 一次 hello 认不认：
 * - 带了专属凭据：凭据有效、未吊销、且绑定的就是这个 workerId；
 * - 没带：退回共享 HUB_TOKEN（旧决定，保留），但已经登记过专属凭据（或被吊销过）的 workerId 不许走这条路——
 *   否则吊销形同虚设，知道 id 的人也能冒名顶替。
 */
export async function authenticateWorker(
  deps: Pick<EnrollmentDeps, 'enrollment' | 'tokens'>,
  hello: { readonly workerId: string; readonly credential?: string | undefined; readonly sharedTokenOk: boolean }
): Promise<WorkerAuth> {
  if (hello.credential) {
    const found = await deps.enrollment.credentialByHash(deps.tokens.hashOf(hello.credential));
    if (!found || found.workerId !== hello.workerId) return { ok: false, reason: '机器凭据无效' };
    if (found.revokedAt !== null) return { ok: false, reason: '这台机器已被吊销' };
    return { ok: true, via: 'credential' };
  }
  const bound = await deps.enrollment.credentialFor(hello.workerId);
  if (bound) return { ok: false, reason: bound.revokedAt !== null ? '这台机器已被吊销' : '这台机器需要用它的专属凭据连接' };
  return hello.sharedTokenOk ? { ok: true, via: 'shared' } : { ok: false, reason: 'token 不匹配' };
}

/**
 * 吊销一台机器：作废凭据并立刻断开（它收到 4401 不再重连）。
 * 主人能吊销任何一台，成员只能吊销自己接入的。凭共享 HUB_TOKEN 接入的老机器也能吊销：
 * 记一条「已吊销」的占位凭据，之后这个 workerId 再拿共享令牌也进不来。
 */
export async function revokeWorker(
  deps: EnrollmentDeps,
  actor: Principal,
  workerId: string
): Promise<Result<WorkerCredential, DomainError>> {
  const online = (await deps.workers.list()).find((worker) => worker.workerId === workerId);
  if (online?.origin === 'local') return err(conflict('本机 Worker 跟 hub 同生共死，不能吊销'));
  const existing = await deps.enrollment.credentialFor(workerId);
  if (!existing && !online) return err(notFound('没有这台机器'));
  const isOwner = actor.user.role === 'owner';
  if (!isOwner && existing?.enrolledBy !== actor.user.id) return err(forbidden('只能吊销你自己接入的机器'));
  if (existing?.revokedAt != null) return err(conflict('这台机器已经吊销过了'));

  const now = deps.now();
  let record: WorkerCredential;
  if (existing) {
    await deps.enrollment.revoke(workerId, now);
    record = { ...existing, revokedAt: now };
  } else {
    record = {
      workerId,
      tokenHash: `revoked:${deps.tokens.issue().hash}`,
      enrolledBy: actor.user.id,
      label: online?.label ?? workerId,
      createdAt: now,
      revokedAt: now
    };
    await deps.enrollment.saveCredential(record);
  }
  await deps.workers.disconnect(workerId, 'revoked');
  await audit(deps, actor.user, 'worker.revoke', `${record.label}（${workerId}）`, existing ? '专属凭据' : '共享 HUB_TOKEN 接入');
  return ok(record);
}

/** 机器列表上「谁接入的」：workerId → 凭据（含已吊销的）。 */
export async function workerCredentials(deps: Pick<EnrollmentDeps, 'enrollment'>): Promise<Map<string, WorkerCredential>> {
  return new Map((await deps.enrollment.listCredentials()).map((credential) => [credential.workerId, credential]));
}
