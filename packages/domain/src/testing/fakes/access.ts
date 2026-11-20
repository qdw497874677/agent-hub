import { accessGrantActive, type AccessGrant, type CustomRole } from '../../access.ts';
import type { ApiToken } from '../../api-token.ts';
import type { ApiTokenRepository } from '../../ports/api-token-repository.ts';
import type { AccessGrantRepository, TeamRoleRepository } from '../../ports/access-repository.ts';
import { createAccessPolicy as createAccessPolicyForTests } from '../../use-cases/authorization.ts';
import type { inMemoryAdmin } from './accounts.ts';
import type { inMemoryAssets } from './assets.ts';
import { fakeAssetSets } from './repos.ts';

/** 授权 / 开放 API 令牌 / 资产审核 / 送达队列的假件。 */

/** 资产审核仓库 + 通知的内存实现。 */
export function inMemoryAssetReview(): {
  review: import('../../ports/asset-review-repository.ts').AssetReviewRepository;
  notifications: import('../../ports/asset-review-repository.ts').NotificationRepository & { rows: import('../../asset-review.ts').Notification[] };
} {
  type S = import('../../asset-review.ts').AssetSubmission;
  type I = import('../../asset-review.ts').InstallRequest;
  const subs: S[] = [];
  const comments: import('../../asset-review.ts').ReviewComment[] = [];
  const requests: I[] = [];
  const settings = new Map<string, import('../../asset-review.ts').AssetReviewSettings>();
  const rows: import('../../asset-review.ts').Notification[] = [];
  return {
    review: {
      addSubmission: async (sub) => void subs.unshift(sub),
      updateSubmission: async (sub) => {
        const at = subs.findIndex((row) => row.id === sub.id);
        if (at >= 0) subs[at] = sub;
      },
      submission: async (id) => subs.find((row) => row.id === id) ?? null,
      submissions: async ({ assetId, status }) =>
        subs.filter((row) => (!assetId || row.assetId === assetId) && (!status || status.includes(row.status))).sort((a, b) => b.createdAt - a.createdAt),
      addComment: async (comment) => void comments.push(comment),
      comments: async (id) => comments.filter((row) => row.submissionId === id),
      addInstallRequest: async (request) => void requests.unshift(request),
      updateInstallRequest: async (request) => {
        const at = requests.findIndex((row) => row.id === request.id);
        if (at >= 0) requests[at] = request;
      },
      installRequest: async (id) => requests.find((row) => row.id === id) ?? null,
      installRequests: async ({ status, workerId, assetId }) =>
        requests.filter((row) => (!status || row.status === status) && (!workerId || row.workerId === workerId) && (!assetId || row.assetId === assetId)),
      settings: async (key) => settings.get(key) ?? null,
      setSettings: async (key, value) => void settings.set(key, value)
    },
    notifications: {
      rows,
      add: async (note) => void rows.unshift(note),
      list: async (userId, limit) => rows.filter((row) => row.userId === userId).slice(0, limit),
      unread: async (userId) => rows.filter((row) => row.userId === userId && row.readAt === null).length,
      markRead: async (userId, ids, at) => {
        rows.forEach((row, index) => {
          if (row.userId === userId && row.readAt === null && (ids === null || ids.includes(row.id))) rows[index] = { ...row, readAt: at };
        });
      }
    }
  };
}

/** 开放 API 令牌的内存仓库（ADR 0015）。 */
export function inMemoryApiTokens(): ApiTokenRepository & { readonly rows: Map<string, ApiToken> } {
  const rows = new Map<string, ApiToken>();
  return {
    rows,
    save: async (token) => void rows.set(token.id, token),
    byId: async (id) => rows.get(id) ?? null,
    byHash: async (hash) => [...rows.values()].find((row) => row.tokenHash === hash) ?? null,
    listByTeam: async (teamId) => [...rows.values()].filter((row) => row.teamId === teamId),
    listBotsByProject: async (projectId) => [...rows.values()].filter((row) => row.kind === 'bot' && row.bot?.projectId === projectId),
    touch: async (id, at) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, lastUsedAt: at });
    }
  };
}

/**
 * 测试用：资产审核（ADR 0016）的整套依赖 = 资产假件 + 账号 / 审计（inMemoryAdmin）+ 审核仓库 + 授权策略。
 * enrolledBy：远端机器 → 接入它的人（决定机器属于谁的团队、算不算「自己的机器」）。
 */
export function inMemoryAssetReviewDeps(
  admin: ReturnType<typeof inMemoryAdmin>,
  assets: ReturnType<typeof inMemoryAssets>,
  enrolledBy: Map<string, string> = new Map()
): {
  deps: import('../../use-cases/asset-review.ts').AssetReviewDeps;
  notifications: ReturnType<typeof inMemoryAssetReview>['notifications'];
  assetSets: ReturnType<typeof fakeAssetSets>;
} {
  const { review, notifications } = inMemoryAssetReview();
  const assetSets = fakeAssetSets();
  const users = admin.accounts.users;
  const policy = createAccessPolicyForTests({
    users,
    settings: admin.accounts.settings,
    enrollment: { credentialFor: async (workerId) => (enrolledBy.has(workerId) ? ({ enrolledBy: enrolledBy.get(workerId) } as never) : null) },
    gateway: { status: async () => assets.workers }
  });
  return {
    deps: {
      ...assets.deps,
      hubAdminId: async () => (await users.firstClusterAdmin())?.id ?? null,
      review,
      notifications,
      audit: admin.deps.audit,
      users,
      teams: admin.accounts.teams,
      policy
    },
    notifications,
    assetSets
  };
}

/** 显式授权 + 自定义角色的内存仓库（ADR 0017）。 */
export function inMemoryAccess(): { grants: AccessGrantRepository; roles: TeamRoleRepository } {
  const grants = new Map<string, AccessGrant>();
  const roles = new Map<string, CustomRole>();
  return {
    grants: {
      save: async (g) => void grants.set(g.id, g),
      byId: async (id) => grants.get(id) ?? null,
      activeFor: async (userId, now) => [...grants.values()].filter((g) => g.userId === userId && accessGrantActive(g, now)),
      listByTeam: async (teamId) => [...grants.values()].filter((g) => g.teamId === teamId).sort((a, b) => b.createdAt - a.createdAt)
    },
    roles: {
      save: async (r) => void roles.set(r.id, r),
      byId: async (id) => roles.get(id) ?? null,
      listByTeam: async (teamId) => [...roles.values()].filter((r) => r.teamId === teamId).sort((a, b) => a.createdAt - b.createdAt),
      delete: async (id) => void roles.delete(id)
    }
  };
}

/** 内存版送达队列（ADR 0031），语义同 SQLite 版。 */
export function inMemoryDeliveries(): import('../../ports/delivery-queue.ts').DeliveryQueue & { rows: Map<string, import('../../delivery.ts').Delivery> } {
  type D = import('../../delivery.ts').Delivery;
  const rows = new Map<string, D>();
  const pendingStates = new Set(['queued', 'sending', 'undelivered']);
  const order = (a: D, b: D) => a.createdAt - b.createdAt || a.seq - b.seq;
  const pendingFor = (sid: string) => [...rows.values()].filter((d) => d.sessionId === sid && d.kind === 'prompt' && pendingStates.has(d.state)).sort(order);
  return {
    rows,
    async save(d) { rows.set(d.id, d); },
    async claimSend(id, now) {
      const d = rows.get(id);
      if (!d || (d.state !== 'queued' && d.state !== 'undelivered')) return false;
      rows.set(id, { ...d, state: 'sending', updatedAt: now });
      return true;
    },
    async reschedule(id, now, nextAt) {
      const d = rows.get(id);
      if (!d || (d.state !== 'queued' && d.state !== 'undelivered')) return false;
      rows.set(id, { ...d, state: 'queued', nextAt, lastError: null, updatedAt: now });
      return true;
    },
    async claimPrompt(incoming) {
      const open = pendingFor(incoming.sessionId);
      const head = open[0];
      if (head?.state === 'undelivered') rows.set(head.id, { ...head, state: 'queued', attempt: 0, nextAt: incoming.updatedAt, updatedAt: incoming.updatedAt });
      const ahead = pendingFor(incoming.sessionId).length > 0;
      const stored = { ...incoming, state: 'queued' as const, nextAt: ahead ? null : incoming.nextAt };
      rows.set(stored.id, stored);
      return { delivery: stored, send: !ahead };
    },
    async byId(id) { return rows.get(id) ?? null; },
    async pendingFor(sid) { return pendingFor(sid); },
    async due(now) {
      const heads = new Map<string, D>();
      for (const d of [...rows.values()].filter((x) => x.kind === 'prompt' && pendingStates.has(x.state)).sort(order)) if (!heads.has(d.sessionId)) heads.set(d.sessionId, d);
      return [...heads.values()].filter((d) => d.state === 'queued' && (d.nextAt ?? 0) <= now);
    },
    async held(sid, kind) { return [...rows.values()].filter((d) => d.sessionId === sid && d.kind === kind && d.state === 'held').at(-1) ?? null; },
    async recent(sid, limit) { return [...rows.values()].filter((d) => d.sessionId === sid && d.kind === 'prompt').sort(order).slice(-limit); },
    async deliveredBefore(cutoff, limit) { return [...rows.values()].filter((d) => d.kind === 'prompt' && d.state === 'delivered' && d.updatedAt <= cutoff).sort((a, b) => a.updatedAt - b.updatedAt).slice(0, limit); },
    async wakeAll(now) { let n = 0; for (const d of rows.values()) if (d.kind === 'prompt' && d.state === 'queued' && (d.nextAt ?? 0) > now) { rows.set(d.id, { ...d, nextAt: now }); n++; } return n; },
    async recoverSending(now) { let n = 0; for (const d of rows.values()) if (d.state === 'sending') { rows.set(d.id, { ...d, state: 'queued', nextAt: now, updatedAt: now }); n++; } return n; }
  };
}
