/**
 * 资产市场 / 审核接口的响应形状（与 packages/domain 的 MarketAsset / SubmissionDetail 等对齐）。
 * 前端不直接依赖 domain 包，所以这里手写一份；server 测试覆盖了真实形状。
 */
import type { AssetDto, AssetRevisionDto } from '@agent-hub/contract';

export type AssetScopeDto = 'personal' | 'team' | 'project' | 'global';
export type SubmissionStatusDto = 'pending' | 'approved' | 'rejected' | 'changes_requested' | 'withdrawn' | 'superseded';

export interface MarketAssetCoreDto extends Omit<AssetDto, 'workerIds' | 'files' | 'bytes'> {
  readonly scope: AssetScopeDto;
  readonly ownerId: string;
  readonly teamId: string | null;
}

export interface MarketAssetDto {
  readonly asset: MarketAssetCoreDto;
  readonly owner: string;
  readonly published: boolean;
  readonly latestSubmission: {
    readonly id: string;
    readonly status: SubmissionStatusDto;
    readonly digest: string;
    readonly reason: string | null;
    readonly createdAt: number;
    readonly targetScope: AssetScopeDto | null;
  } | null;
  readonly workerIds: readonly string[];
  readonly canMaintain: boolean;
}

export interface FindingLineDto {
  readonly level: 'info' | 'warn' | 'high';
  readonly rule: string;
  readonly path: string;
  readonly line: number | null;
  readonly message: string;
}

export interface McpRiskSummaryDto {
  readonly transport: 'stdio' | 'http';
  readonly level: 'low' | 'medium' | 'high';
  readonly command: string | null;
  readonly args: readonly string[];
  readonly url: string | null;
  readonly host: string | null;
  readonly packages: readonly { readonly name: string; readonly pinned: boolean }[];
  readonly secrets: readonly string[];
  readonly notes: readonly string[];
  readonly changed: readonly string[];
}

export interface AssetSubmissionDto {
  readonly id: string;
  readonly assetId: string;
  readonly digest: string;
  readonly previous: string;
  readonly submittedBy: string;
  readonly origin: 'user' | 'git' | 'token' | 'migration';
  readonly tokenId: string | null;
  readonly targetScope: AssetScopeDto | null;
  readonly status: SubmissionStatusDto;
  readonly required: number;
  readonly approvals: readonly { readonly userId: string; readonly at: number; readonly selfApproved: boolean }[];
  readonly decidedBy: string | null;
  readonly reason: string | null;
  readonly report: {
    readonly findings: readonly FindingLineDto[];
    readonly mcp: McpRiskSummaryDto | null;
    readonly secrets: readonly { readonly name: string; readonly from: 'personal' | 'team' | 'hub' | null }[];
    readonly filesChanged: number;
  };
  readonly createdAt: number;
  readonly decidedAt: number | null;
}

export interface ReviewQueueItemDto {
  readonly submission: AssetSubmissionDto;
  readonly asset: MarketAssetCoreDto;
  readonly submitter: string;
  readonly routedToHub: boolean;
}

export interface SubmissionDetailDto {
  readonly submission: AssetSubmissionDto;
  readonly asset: MarketAssetCoreDto;
  readonly revision: AssetRevisionDto | null;
  readonly previous: AssetRevisionDto | null;
  readonly comments: readonly { id: string; authorId: string; author: string; path: string | null; line: number | null; body: string; at: number }[];
  readonly submitter: string;
  readonly approvers: readonly { readonly name: string; readonly selfApproved: boolean; readonly at: number }[];
  readonly reviewers: readonly string[];
  readonly canApprove: boolean;
  readonly approveBlocked: string | null;
  readonly canDecide: boolean;
  readonly canWithdraw: boolean;
  readonly needed: number;
}

export interface InstallRequestDto {
  readonly id: string;
  readonly assetId: string;
  readonly workerId: string;
  readonly requestedBy: string;
  readonly status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  readonly decidedBy: string | null;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly decidedAt: number | null;
}

export interface NotificationDto {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly link: string;
  readonly at: number;
  readonly readAt: number | null;
}

export interface AssetReviewSettingsDto {
  readonly reviewers: readonly string[];
  readonly twoReviewers: { readonly global: boolean; readonly mcpStdio: boolean };
}
