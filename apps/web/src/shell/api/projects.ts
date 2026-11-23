import type { ProjectDto } from '@agent-hub/contract';

export type {
  AgentProfileDto,
  AgentProfileInput,
  CanvasDto,
  ProjectDto,
  ProjectSummaryDto,
  SaveLayoutRequest
} from '@agent-hub/contract';

/** 项目级 worktree 配置（PATCH /api/projects/:id）。形状取契约里 ProjectDto.worktree，只有一份真源。 */
export interface ProjectWorktreePatch {
  worktree: NonNullable<ProjectDto['worktree']>;
}

/**
 * 项目仓库清单（PATCH /api/projects/:id 的 repos，docs/design/multi-repo.md §11.2）。
 * 有 id 就带上：后端按 id 保留老仓库的身份，组合工作目录的成员才不会指丢。
 *
 * `credential`：非空 = 设置/覆盖访问令牌，`''` = 清除，不带 = 保持原值。
 * `hasToken` 只在响应里出现（服务端从不回明文），这里写出来是为了读回来时类型对得上。
 */
export interface ProjectReposPatch {
  repos: readonly {
    id?: string;
    name?: string;
    url: string;
    defaultBranch?: string | null;
    credential?: string;
    hasToken?: boolean;
  }[];
  primaryRepoId?: string | null;
}

/**
 * 保存前的仓库检查（POST /api/projects/:id/repos/check）：在 Worker 上试 clone / 试分支，
 * 免得等到派生任务才报「Remote branch main not found」。`unavailable` 非空 = 这台机器没查成。
 */
export interface ProjectReposCheckDto {
  workerId: string | null;
  workerLabel: string | null;
  unavailable: string | null;
  /** 这次用的是哪份凭据；旧后端没有这个字段。 */
  credentialSource?: 'draft' | 'saved' | 'worker' | null;
  results: {
    name: string;
    url: string;
    branch: string | null;
    ok: boolean;
    defaultBranch: string | null;
    message: string | null;
    /** 后端给的失败分类；旧后端没有，界面不猜原因。 */
    failureKind?: 'authentication' | 'branch_missing' | 'unreachable' | 'credential_unavailable' | null;
    credentialSource?: 'draft' | 'saved' | 'worker' | null;
  }[];
}
