# agent 的 git / 分支工具（issue #216）

空白 Worker 如何通过会话内工具使用项目级 HTTPS/SSH 凭证，见后续提案 [项目 Git 授权](project-git-access.md)。

状态：设计中（2026-11-15）。来源：GitHub issue #216「MCP 缺口：agent 无法经 hub 提交/推送/建 PR，任务也不能绑定分支」。

## 1. 问题

`git-workflow` 的能力只在 HTTP 上暴露（`apps/server/src/git-routes.ts`），MCP 工具集里一个 `git.*` 都没有。于是 agent 要「改代码 → commit → push → 建 PR」只能 shell 出去跑 `git`/`gh`，绕开：

- `git.push` 权限（`packages/domain/src/access.ts:18`）；
- 审计（`git.commit` / `git.push` / `git.pr`）；
- `task_pull_requests` 回填（agent 建完 PR，任务卡上看不到）。

另外 `Task.branch` 字段存在（`packages/domain/src/task.ts:23`）但全仓没有赋值点，`task.create` 也不能指定从哪个分支开工。

## 2. 本次范围（P0）

1. **git 工具**：`git.state`、`git.commit`、`git.push`、`git.pr`、`git.pull_requests`。
2. **任务绑定分支**：`task.create` 增加可选 `base_branch`，存到 `Task.baseBranch`；建隔离 worktree 时以它为起点；建好后把实际分支回写 `Task.branch`。
3. 工具结果与 HTTP 一致：PR 落地后写 `task_pull_requests`，`git.pull_requests` / `task.get` 都能看到。

P1（不在本次）：`project.update`、`session.derive/stop`、`run.checks`；P2：artifact、workspace 文件读取。

## 3. 谁在调用（权限主体）

工具只有 `ToolGrant`（含 `sessionId`），没有 principal。git 工作流的关键权限是 `git.push`，不能因为「是内部调用」就跳过，所以工具需要一个人格：

- 会话属于 bot（`botOfSession`）→ 用 bot 的 principal（`{ kind: 'bot', … }`，它的项目共享权限就是上限）；
- 否则用会话创建者（owner）的 principal。

装配层提供 `subjectOf(sessionId): Promise<Subject | null>`（`apps/server/src/main.ts`），注入 provider；domain 不碰存储。

## 4. 工具契约

全部 `scope: 'git'`（新增到 `ToolScope` / `TOOL_SCOPES` / `DEFAULT_TOOL_SCOPES`），`perMinute: 10`（push/PR 适合这个量级；commit 可以更松，但不另开桶）。

| 工具 | 入参 | 返回 |
| --- | --- | --- |
| `git.state` | `{}` | `GitState`（isGit/branch/defaultBranch/hasOrigin/repo/files/ahead/upstream/canPush/prBlocked/prVia/pullRequests） |
| `git.commit` | `{ message }` | `GitRunOutcome` |
| `git.push` | `{ message }` | `GitRunOutcome` |
| `git.pr` | `{ message, title?, body? }` | `GitRunOutcome` |
| `git.pull_requests` | `{}` | `PullRequestLink[]`（当前任务） |

- `message` 1–2000 字符；`title` ≤ 200；`body` ≤ 8000。
- 组合工作空间：入参加可选 `workspace`（成员 workspaceId），传给 `run(..., member)` / `state(..., member)`；不传且是组合空间时，工作流自己会回「请选择要提交的仓库」，工具把它原样回给模型。
- 失败一律走现有 `Result`：没权限是 `forbidden`，工作流里 `git.push` 被拒的错误文案不包装。
- 描述里明确写「不要用 shell 跑 git/gh；推送与 PR 走后端审计」。

## 5. 任务分支

- `Task` 新增 `baseBranch: string | null`（默认 null）。
- `task.create` 工具 schema 加 `base_branch`（1–200，可选）；`createTaskUseCase` 透传。
- `prepareTemporaryWorkspaceUseCase`：`mode === 'isolated' && !command.branch` 时，`base` 的取法改为
  `command.base ?? task.baseBranch ?? project.repo?.defaultBranch ?? base.value.branch`。
  注意 `task.baseBranch` 是远端分支名，git worktree 需要 `origin/<name>`；由 use case 统一规范成 `origin/<name>`（已经以 `origin/` 开头的原样）。
- 建好后 `deps.tasks.save({ ...task, branch })` 回写实际分支（`task.branch` 只在这里写，避免多处漂移）。
- `task.get` 的返回带 `baseBranch`（与 `branch` 并列）。

## 6. 不做什么

- 不做 `git checkout` / reset / rebase / 合并请求的合并——这些仍然该由人操作或后续单独设计。
- 不给 shell 里的 `git push` 做拦截（本轮只把正确路径铺好）。
- 不改 HTTP 路由与前端 git 面板。

## 7. P1（已落地，2026-11-15，提交 87e6fa8）

issue #216 的 P1 三项也做成工具，装配在同一层（`createProjectToolProvider` / `createSessionControlToolProvider`）：

| 工具 | scope | 入参 | 返回 |
| --- | --- | --- | --- |
| `project.update` | `project` | `{ description?, checks? }` | `{ id, name, description, checks }` |
| `run.checks` | `project` | `{}` | `{ ran, checks: [{ command, exit_code, timed_out, output }], passed }` |
| `session.derive` | `session:control` | `{ title? }` | `{ session_id, task_id, project_id, title }` |
| `session.stop` | `session:control` | `{ session_id? }` | `{ session_id, stopped }` |

- `Project.checks`：最多 5 条、每条 ≤300 字、不能换行；只能通过 `PATCH /api/projects/:id` 由项目所有者配置，agent 不能随手跑任意命令——`run.checks` 只跑项目声明过的命令，按顺序、遇非 0 即停，输出取末尾 8KB（`ws.run_setup` 已抹凭据），超时 10 分钟。
- `project.update` 只允许改 `description` 与 `checks`，权限实时求值 `project.update`；`session.stop` 只能停同一项目里的会话（或自己），`session.derive` 继承调用方的任务/项目/工作目录/运行时与模型，写成一次普通派生（同任务下的另一条会话），不复制对话。
- 手段与边界：`run.checks` 跑在会话所在机器（`gateway.git(workerId).runSetup`），因此需要该机器 `git` 能力；机器离线/工作目录不可用时明确报错，不退回 hub 本机。
