import { call, post } from './http.ts';
import type {
  DelegationPublishDto,
  DelegationsDto,
  StartDelegationDto,
  StartDelegationInput
} from '../../atoms/delegation-types.ts';

/**
 * 主会话派工（workspace delegation A）。
 *
 * DTO 的形状在 `apps/web/src/atoms/delegation-types.ts`（纯类型、无浏览器依赖），
 * 这里只负责转发类型 + 发请求。服务端刻意脱敏（没有请求指纹 / claim / 仓库地址 / 凭据），这里也不补字段。
 */
export type {
  DelegationDto,
  DelegationFailureDto,
  DelegationFailureKind,
  DelegationPublishDto,
  DelegationStartupDto,
  DelegationState,
  DelegationsDto,
  PublishedPullRequestDto,
  PublishAttemptDto,
  PublishAttemptState,
  PublishRemoteFactsDto,
  StartDelegationDto,
  StartDelegationInput
} from '../../atoms/delegation-types.ts';

const dq = (delegationId: string) => `/api/workspace-delegations/${encodeURIComponent(delegationId)}`;
/** 派工挂在主会话下面：`/api/coordinators/<sessionId>/delegations`，不是 `/api/sessions/...`。 */
const cq = (sessionId: string) => `/api/coordinators/${encodeURIComponent(sessionId)}/delegations`;

export const delegationsApi = {
  list: (coordinatorSessionId: string) =>
    call<DelegationsDto>(cq(coordinatorSessionId)).then((body) => body.delegations),
  start: (coordinatorSessionId: string, body: StartDelegationInput) =>
    post<StartDelegationDto>(cq(coordinatorSessionId), body),
  /**
   * 人确认 Runtime 已经提好的一条提议：不带 body，也不许顺便改参数——
   * 目标、仓库、基线、说明、配置都以服务端存着的那条提议为准。
   */
  confirm: (coordinatorSessionId: string, delegationId: string) =>
    post<StartDelegationDto>(
      `${cq(coordinatorSessionId)}/${encodeURIComponent(delegationId)}/confirm`,
      undefined
    ),
  publishState: (delegationId: string) => call<DelegationPublishDto>(`${dq(delegationId)}/publish`),
  /** 人确认后推送 + 开草稿 PR。`approvalKey` 要稳定：同一次批准的重试必须原样复用。 */
  publish: (delegationId: string, body: { approvalKey: string; expectedHeadSha: string }) =>
    post<DelegationPublishDto>(`${dq(delegationId)}/publish`, body),
  /** 只读对账：不推送、不建 PR，只核对已存的尝试与远端 / PR 列表。 */
  reconcile: (delegationId: string, body: { approvalKey: string }) =>
    post<DelegationPublishDto>(`${dq(delegationId)}/reconcile`, body)
};
