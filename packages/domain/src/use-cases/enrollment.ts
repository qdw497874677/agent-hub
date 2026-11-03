import { newId } from '../ids.ts';
import { authorizeWorker, type AccessPolicy } from './authorization.ts';
import type { AuditEntry, HubSettings, Principal } from '../account.ts';
import { canAddMachines } from '../account.ts';
import { CREDENTIAL_PREFIX, PAIRING_PREFIX, PAIRING_TTL_MS, ROTATION_GRACE_MS } from '../enrollment.ts';
import { rotationState } from '../enrollment.ts';
import type { RotationState, WorkerCredential } from '../enrollment.ts';
import { WORKER_CAPABILITY_PRESETS, WORKER_PRESET_LABELS, narrowCapabilities, normalizeCapabilities } from '../worker-capability.ts';
import type { WorkerCapability, WorkerCapabilityPreset } from '../worker-capability.ts';
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
  readonly workers: Pick<WorkerControl, 'list' | 'disconnect' | 'rotateCredential'>;
  readonly now: () => number;
  /** 新机器的 workerId；默认 `remote-<8 位>`。 */
  readonly newWorkerId?: () => string;
  /** 装了账号体系就走 can()（ADR 0011）。 */
  readonly access?: AccessPolicy;
}

export interface IssuedPairing {
  readonly code: string;
  readonly expiresAt: number;
  readonly preset: WorkerCapabilityPreset;
}

const isPreset = (value: unknown): value is WorkerCapabilityPreset =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(WORKER_CAPABILITY_PRESETS, value);

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
    id: newId(),
    actorId: actor.id as AuditEntry['actorId'],
    actorEmail: actor.email,
    action,
    target,
    detail,
    at: deps.now()
  });
}

const allowedToAdd = (principal: Principal | null, settings: HubSettings): principal is Principal =>
  canAddMachines(principal, settings);

/** 「添加机器」：签发一个 15 分钟、一次性的 Pairing Code。明文只在这次返回里出现。 */
export async function issuePairingCode(
  deps: EnrollmentDeps,
  principal: Principal | null,
  /** 能力预设（ADR 0030 P4）；不给 = full。 */
  preset: unknown = 'full'
): Promise<Result<IssuedPairing, DomainError>> {
  if (!allowedToAdd(principal, await deps.settings.get())) return err(forbidden('你没有添加机器的权限，请联系主人'));
  if (!isPreset(preset)) return err(invalid('不认识的权限预设'));
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
    workerId: null,
    capabilities: WORKER_CAPABILITY_PRESETS[preset]
  });
  await audit(deps, principal.user, 'worker.pair', 'pairing', `有效至 ${new Date(expiresAt).toISOString()} · 权限 ${WORKER_PRESET_LABELS[preset]}`);
  return ok({ code, expiresAt, preset });
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

  const workerId = deps.newWorkerId?.() ?? `remote-${newId().slice(0, 8)}`;
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
    revokedAt: null,
    // 只能收窄：码上的能力集就是上限；老码（null）= full
    capabilities: narrowCapabilities(null, pairing.capabilities ?? null)
  });
  await audit(deps, creator, 'worker.enroll', `${label}（${workerId}）`, '凭接入码');
  return ok({ workerId, credential });
}

export type WorkerAuth =
  | { readonly ok: true; readonly via: 'credential' | 'shared'; readonly capabilities?: readonly WorkerCapability[] }
  | { readonly ok: false; readonly reason: string };

/**
 * 一次 hello 认不认：
 * - 带了专属凭据：凭据有效、未吊销、且绑定的就是这个 workerId；
 * - 没带：退回共享 HUB_TOKEN（旧决定，保留），但已经登记过专属凭据（或被吊销过）的 workerId 不许走这条路——
 *   否则吊销形同虚设，知道 id 的人也能冒名顶替。
 */
export async function authenticateWorker(
  deps: Pick<EnrollmentDeps, 'enrollment' | 'tokens' | 'now'>,
  hello: {
    readonly workerId: string;
    readonly credential?: string | undefined;
    readonly sharedTokenOk: boolean;
    /** 来源地址与版本（ADR 0030 D3）：认过了就记到凭据上。 */
    readonly address?: string | null | undefined;
    readonly userAgent?: string | null | undefined;
  }
): Promise<WorkerAuth> {
  if (hello.credential) {
    const hash = deps.tokens.hashOf(hello.credential);
    const found = await deps.enrollment.credentialByHash(hash);
    if (!found || found.workerId !== hello.workerId) return { ok: false, reason: '机器凭据无效' };
    if (found.revokedAt !== null) return { ok: false, reason: '这台机器已被吊销' };
    if (found.pendingHash === hash) {
      // 轮换中的新凭据：宽限期内连上就转正（旧的作废），过期就作废新的、留旧的
      const now = deps.now();
      if (found.pendingUntil == null || found.pendingUntil <= now) {
        await deps.enrollment.failRotation(found.workerId, now);
        return { ok: false, reason: '新凭据的轮换已过期' };
      }
      if (!(await deps.enrollment.completeRotation(found.workerId, hash, now))) return { ok: false, reason: '机器凭据无效' };
    }
    await deps.enrollment.recordConnection(found.workerId, { at: deps.now(), address: hello.address ?? null, userAgent: hello.userAgent ?? null });
    return { ok: true, via: 'credential', capabilities: normalizeCapabilities(found.capabilities ?? null) };
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
  if (deps.access) {
    const allowed = await authorizeWorker(deps.access, actor, workerId, 'worker.manage');
    if (!allowed.ok) return err(forbidden('只能吊销你自己接入的机器'));
  } else if (actor.user.role !== 'owner' && existing?.enrolledBy !== actor.user.id) return err(forbidden('只能吊销你自己接入的机器'));
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

/**
 * 手动轮换一台机器的凭据（ADR 0030 D3，Q6 只手动）：生成新凭据、经当前连接下发，旧的在宽限期内继续有效。
 * 新凭据 5 分钟内连上才转正；没换上就作废新的、留旧的，UI 显示「轮换失败」。Worker 离线不能轮换。
 */
export async function rotateWorkerCredential(
  deps: EnrollmentDeps,
  actor: Principal,
  workerId: string
): Promise<Result<WorkerCredential, DomainError>> {
  const existing = await deps.enrollment.credentialFor(workerId);
  if (!existing) return err(notFound('这台机器没有专属凭据，不能轮换'));
  if (deps.access) {
    const allowed = await authorizeWorker(deps.access, actor, workerId, 'worker.manage');
    if (!allowed.ok) return err(forbidden('只能轮换你自己接入的机器'));
  } else if (actor.user.role !== 'owner' && existing.enrolledBy !== actor.user.id) return err(forbidden('只能轮换你自己接入的机器'));
  if (existing.revokedAt !== null) return err(conflict('这台机器已经吊销了，只能重新配对'));
  const now = deps.now();
  if (existing.pendingHash && existing.pendingUntil != null && existing.pendingUntil > now) return err(conflict('上一次轮换还在进行中'));
  const online = (await deps.workers.list()).some((worker) => worker.workerId === workerId);
  if (!online || !deps.workers.rotateCredential) return err(conflict('机器不在线，不能轮换；只能吊销后重新配对'));

  const { token } = deps.tokens.issue();
  const credential = `${CREDENTIAL_PREFIX}${token}`;
  const pendingHash = deps.tokens.hashOf(credential);
  const until = now + ROTATION_GRACE_MS;
  await deps.enrollment.beginRotation(workerId, pendingHash, until);
  if (!(await deps.workers.rotateCredential(workerId, credential))) {
    await deps.enrollment.failRotation(workerId, now);
    return err(conflict('下发新凭据失败（机器可能刚断开），旧凭据继续有效'));
  }
  await audit(deps, actor.user, 'worker.rotate', `${existing.label}（${workerId}）`, '已下发新凭据，等它用新凭据重连');
  return ok({ ...existing, pendingHash, pendingUntil: until });
}

/** 宽限期过了还没换上的轮换：作废新凭据、记失败（列表时顺手清）。 */
export async function expireRotations(deps: Pick<EnrollmentDeps, 'enrollment' | 'now'>): Promise<void> {
  const now = deps.now();
  for (const c of await deps.enrollment.listCredentials()) {
    if (c.pendingHash && c.pendingUntil != null && c.pendingUntil <= now) await deps.enrollment.failRotation(c.workerId, now);
  }
}

export interface CredentialStatus {
  readonly workerId: string;
  readonly rotation: RotationState;
  readonly rotatedAt: number | null;
  readonly pendingUntil: number | null;
  readonly rotationFailedAt: number | null;
}

/** 一台机器凭据的轮换状态（不含任何哈希）。能管这台机器的人才看得到。 */
export async function credentialStatus(
  deps: EnrollmentDeps,
  actor: Principal,
  workerId: string
): Promise<Result<CredentialStatus, DomainError>> {
  await expireRotations(deps);
  const existing = await deps.enrollment.credentialFor(workerId);
  if (!existing || existing.revokedAt !== null) return err(notFound('这台机器没有有效的专属凭据'));
  if (deps.access) {
    const allowed = await authorizeWorker(deps.access, actor, workerId, 'worker.manage');
    if (!allowed.ok) return err(forbidden('只能查看你自己接入的机器'));
  } else if (actor.user.role !== 'owner' && existing.enrolledBy !== actor.user.id) return err(forbidden('只能查看你自己接入的机器'));
  return ok({
    workerId,
    rotation: rotationState(existing, deps.now()),
    rotatedAt: existing.rotatedAt ?? null,
    pendingUntil: existing.pendingUntil ?? null,
    rotationFailedAt: existing.rotationFailedAt ?? null
  });
}
