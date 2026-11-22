/**
 * 派工 / 发布的线上形状（与 `apps/server/src/workspace-delegation*.ts` 一一对应）。
 *
 * 单独放一份纯类型的文件：atom 与它的单测只要形状，不能因为 `import type` 就把
 * `shell/api/http.ts`（用到 document / window）拉进只编 ES2024 的根 tsconfig。
 * 浏览器侧的 `shell/api/delegations.ts` 只做转发 + 发请求。
 */
export type DelegationState = 'pending' | 'preparing' | 'prepared' | 'failed' | 'uncertain' | 'cancelled';
export type DelegationFailureKind = 'fatal' | 'uncertain';

export interface DelegationFailureDto {
  kind: DelegationFailureKind;
  message: string;
  at: number;
}

/** 服务端脱敏后的启动配置（模型可能为空，因为模型是提议时才定下来的）。 */
export interface DelegationStartupDto {
  agentId: string;
  model: string | null;
  profileId: string | null;
}

export interface DelegationDto {
  id: string;
  coordinatorSessionId: string;
  requestKey: string;
  projectId: string;
  taskId: string;
  repoId: string;
  workerId: string;
  baseBranch: string;
  baseSha: string | null;
  instructions: string;
  executionSessionId: string;
  worktreePath: string;
  branch: string;
  state: DelegationState;
  failure: DelegationFailureDto | null;
  /**
   * 服务端说了算：只有「由 Runtime 提议、还没人确认、也没被抢占」的那一条才是 true。
   * 界面不许自己按 state 推——pending 里也有等 Runtime 提议的。
   */
  canConfirm?: boolean;
  startup?: DelegationStartupDto | null;
  createdAt: number;
  updatedAt: number;
}

export interface DelegationsDto {
  delegations: DelegationDto[];
}

export interface StartDelegationInput {
  requestKey: string;
  taskId: string;
  repoId: string;
  baseBranch: string;
  instructions: string;
  agentId: string;
  model?: string | null;
  profileId?: string | null;
  options?: Readonly<Record<string, string | boolean>>;
}

export interface StartDelegationDto {
  /** true = 这次请求新建了记录；false = 同键复用。 */
  created: boolean;
  /** 这次调用是否拿到了副作用执行权。 */
  claimed: boolean;
  delegation: DelegationDto;
}

/** 发布尝试的状态机（`packages/domain/src/use-cases/workspace-delegation-publish.ts:38`）。 */
export type PublishAttemptState = 'publishing' | 'published' | 'failed' | 'uncertain';

export interface PublishRemoteFactsDto {
  sha: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  defaultBranch: string;
  remoteSha: string | null;
  published: boolean;
}

export interface PublishedPullRequestDto {
  repo: string;
  number: number;
  url: string;
  headRef: string;
  headSha: string;
  base: string;
  baseRepo: string;
  state: 'open';
  draft: true;
}

export interface PublishAttemptDto {
  state: PublishAttemptState;
  headSha: string;
  remote: PublishRemoteFactsDto | null;
  pullRequest: PublishedPullRequestDto | null;
  failure: DelegationFailureDto | null;
  createdAt: number;
  updatedAt: number;
}

export interface DelegationPublishDto {
  delegationId: string;
  state: DelegationState;
  projectId: string;
  taskId: string;
  executionSessionId: string;
  workerId: string;
  /** `owner/name`；URL 解析不出来时是 null（这种也发布不了）。 */
  repo: string | null;
  branch: string;
  baseBranch: string;
  baseSha: string | null;
  failure: DelegationFailureDto | null;
  /**
   * 工作区当前的权威 HEAD（服务端在 GET 里只读给出）。
   * 拿不到时是 null，原因写在 `headUnavailable` 里——不要拿 `attempt.headSha` 顶上，
   * 那是上一次批准的提交，改了代码就过期了。
   */
  headSha?: string | null;
  headUnavailable?: string | null;
  attempt: PublishAttemptDto | null;
  createdAt: number;
  updatedAt: number;
  /** 只有 POST 的响应带这三个标记。 */
  attempted?: boolean;
  replayed?: boolean;
  reconciled?: boolean;
}
