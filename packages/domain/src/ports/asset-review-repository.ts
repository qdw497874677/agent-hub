import type {
  AssetReviewSettings,
  AssetSubmission,
  InstallRequest,
  Notification,
  ReviewComment,
  SubmissionStatus
} from '../asset-review.ts';

/** 资产审核的持久化（ADR 0016）：提交、行内评论、安装申请、团队 / hub 审核设置。 */
export interface AssetReviewRepository {
  addSubmission(submission: AssetSubmission): Promise<void>;
  updateSubmission(submission: AssetSubmission): Promise<void>;
  submission(id: string): Promise<AssetSubmission | null>;
  /** 新的在前；status 给了就只要这些状态的。 */
  submissions(filter: { assetId?: string; status?: readonly SubmissionStatus[] }): Promise<AssetSubmission[]>;
  addComment(comment: ReviewComment): Promise<void>;
  comments(submissionId: string): Promise<ReviewComment[]>;
  addInstallRequest(request: InstallRequest): Promise<void>;
  updateInstallRequest(request: InstallRequest): Promise<void>;
  installRequest(id: string): Promise<InstallRequest | null>;
  installRequests(filter: { status?: InstallRequest['status']; workerId?: string; assetId?: string }): Promise<InstallRequest[]>;
  /** key = teamId 或 'hub'；没设过返回 null。 */
  settings(key: string): Promise<AssetReviewSettings | null>;
  setSettings(key: string, settings: AssetReviewSettings): Promise<void>;
}

/** 站内通知（ADR 0016 §通知）。只增；已读打时间戳。 */
export interface NotificationRepository {
  add(notification: Notification): Promise<void>;
  /** 新的在前。 */
  list(userId: string, limit: number): Promise<Notification[]>;
  unread(userId: string): Promise<number>;
  /** ids = null 表示全部标成已读。 */
  markRead(userId: string, ids: readonly string[] | null, at: number): Promise<void>;
}
