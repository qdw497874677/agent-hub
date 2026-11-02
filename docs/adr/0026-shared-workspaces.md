# ADR 0026：工作空间独立于项目（团队级，可关联多个项目）

- 状态：accepted（2026-11-02 David 定了 Q1–Q7，见末尾「定稿」）
- 相关：ADR 0013、ADR 0025、docs/design/workspaces.md（本 ADR 修订其 §2、§4、§6、§10）

## 背景

现在每个工作空间都挂在一个项目上（`workspaces.project_id`），而且「一个目录最多属于一个项目」。实际用法里，同一个仓库目录常常要给好几个项目用（比如「前端改版」和「性能优化」都在同一个 monorepo 里干活），现在只能二选一，或者在同一台机器上再 clone 一份。
PR #173 之后建项目时已经不选目录，工作空间只能在开始任务时创建，项目设置里也没有「添加」入口。

## 决定

### 1. 模型

```
Team ─┬─< Workspace（长期）  id, teamId, workerId, path, source, label, isGit, state, createdBy, createdAt
      │        │
      │        └─< ProjectWorkspace（关联表）projectId, workspaceId, linkedBy, linkedAt   主键 (projectId, workspaceId)
      └─< Project
Workspace（临时） 仍归创建它的任务所有：projectId + ownerTaskId，不进关联表，不能共享
Session  workspaceId 不变；另外记 projectId（经 task）用来按项目过滤改动
```

- 长期工作空间 = 团队的资源（某台 Worker 上的一个目录），不再属于某个项目。
- 项目和长期工作空间是多对多，靠 `project_workspaces` 关联。
- 临时工作空间不变：`kind = temporary`，`owner_task_id` 必填，`team_id` 取任务所在项目的团队，不能被关联到别的项目。
- worktree 型临时工作空间的 `base_workspace_id` 可以指向一个共享的长期工作空间；任务分支仍是 `agent-hub/<slug>-<短 id>`，所以不同项目的任务不会撞分支。

### 2. 创建入口（三处，同一个选择器组件）

1. **团队工作空间页**（新入口，位置待定，见 Q1）：按机器分组列出团队的所有长期工作空间，每个显示「用在哪些项目」；可以新建（新建空目录 / 下载仓库 / 选已有目录）。
2. **项目设置 → 关联工作空间**：列出本项目关联的工作空间；「关联已有」从团队列表里挑；「新建并关联」走同一个创建流程，建完自动关联。
3. **开始任务**：**只能选本项目已关联的**（Q5 定稿：不当场关联）。一个都没关联时，明确给出「关联工作空间…」入口，打开项目设置的关联页；「新建持久工作空间」（建好即关联本项目）和「新建临时工作空间」保留。

### 3. 删除

- **取消关联**（项目设置里）：只删关联行，不碰目录，不影响别的项目。本项目有运行中的会话在用时不让取消。
- **删除工作空间**（团队页）：先列出「正在被这些项目使用：A、B」，二次确认；沿用现有规则：默认只移除登记，「同时删除目录」只对 `created / cloned` 开放；有运行中的会话时拒绝。
- 删项目 = 归档，删掉它的关联行，不删工作空间。

### 4. 权限

- 能看 / 用某个工作空间 ⇔ 对它关联的**任意一个**项目有相应权限（`project.read` 看，`session.create` 在里面跑），或者有团队级 `workspace.manage`。
- 新权限 `workspace.manage`（团队级，默认给 Owner/Admin）：在团队页新建、删除、关联到任意项目。项目成员能把团队里自己**看得见**的工作空间关联到自己有 `project.manage` 的项目。
- 关联已有目录（`source = linked`，非托管目录）仍需 Owner（沿用不变量 9）。
- **文件 / 改动页**：文件树按工作空间展示（有权就能看）；「改动」只列**当前项目**的会话造成的改动（按 session → task → project 过滤），别的项目的会话只显示一行「另有 N 个其他项目的会话在这里改过文件」，不展开内容。

### 5. 并发警告跨项目

`concurrentWarning` 的输入从「本项目在这个工作空间的运行中会话」改成「这个工作空间所有运行中的会话」。别的项目的会话只显示项目名 + 数量（看不见的项目只显示「另一个项目」）。仍然只警告不阻止。

### 6. 唯一性

- 原「一个目录最多属于一个项目」**取消**。
- 新规则：同一团队、同一 Worker 上，活跃长期工作空间的 `path` 唯一，且不能互相嵌套（domain 检查，DB 兜底唯一索引 `(team_id, worker_id, path) WHERE state <> 'removed'`）。
- 临时工作空间仍在 `.worktrees/` 或托管目录下，不和长期的嵌套。
- 一台 Worker 只属于一个团队（现状），所以实际上等价于「每台 Worker 上路径唯一」。

### 7. 迁移与 API

迁移（一次性、幂等）：
1. `workspaces` 加 `team_id`（取 project 的团队），长期工作空间的 `project_id` 改为可空。
2. 每个长期工作空间 → 一行 `project_workspaces(project_id, id)`。
3. 临时工作空间保留 `project_id`、`owner_task_id`，不建关联。
4. 旧唯一索引换成按团队的；旧数据本来就不冲突，不需要合并。
5. `project_id` 列保留一个版本做回滚。

API：
- 保留 `POST /api/projects/:id/workspaces`（兼容）：`long_lived` = 在团队里创建 + 关联到该项目；`temporary` 行为不变。`GET /api/projects/:id/workspaces` 返回关联的 + 本项目的临时工作空间。
- 新增：`GET/POST /api/teams/:id/workspaces`、`DELETE /api/workspaces/:id`（团队级删除）、`PUT /api/projects/:id/workspaces/:wsId`（关联）、`DELETE /api/projects/:id/workspaces/:wsId`（取消关联；对临时工作空间 = 原来的移除）。
- 工作空间对象加 `teamId`、`projects: {id,name}[]`（只含调用者能看到的）。

### 8. 六边形落地

- **domain**
  - `workspace.ts`：`Workspace` 加 `teamId`，长期的去掉 `projectId`；新 `ProjectWorkspaceLink`；纯函数 `nestedOrTaken` 改为按团队+Worker；`concurrentWarning` 接收跨项目会话；`canUnlink(link, runningSessions)`、`canDelete(ws, runningSessions)`；`visibleTo(ws, links, can)`。
  - 端口：`WorkspaceRepository` 加 `listByTeam`、`listByProject`（关联+临时）、`link / unlink / linksOf`；`AccessPolicy` 加 `workspace.manage`。`WorkspaceHost`、`WorkspaceBrowser` 不变。
  - 用例：新 `createTeamWorkspace`、`linkWorkspace`、`unlinkWorkspace`、`deleteWorkspace`；`prepareWorkspace` 支持「选未关联的 → 当场关联」；`workspace-files` 的改动按项目过滤；`delete-project` 改为删关联。
- **contract**：`workspaceSchema` 加 `teamId / projects`；新请求 schema。
- **storage-sqlite**：表 `project_workspaces`；`workspaces.team_id`；新索引；迁移。
- **web**：团队工作空间页；项目设置「关联工作空间」（替换现在只读的列表）；`workspace-chooser.tsx` 分「已关联 / 团队里其他 / 新建」。

## 不做

- 跨团队共享工作空间。
- 临时工作空间共享。
- 工作空间级别的单独授权（只靠关联项目推导）。

## 决策清单（原待定项）

- **Q1 团队工作空间页放哪**：A. 顶部导航新入口「工作空间」（推荐，和「项目」并列）；B. 团队设置里的一页；C. 两者都有。
- **Q2 允许没关联任何项目的工作空间吗**：A. 允许（推荐：团队页能先建好，取消最后一个关联不会丢登记）；B. 不允许，最后一个关联取消时提示「同时移除登记？」。
- **Q3 git 仓库配方放哪**：A. 留在项目上（现状，下载仓库时用项目的 repo）；B. 挪到工作空间上（推荐：工作空间知道自己从哪 clone，`ws.inspect` 读 origin 记下来；项目的 repo 只作为「新建」时的默认值）；C. 两边都有。
- **Q4 谁能把工作空间关联到项目**：A. 项目的 `project.manage` + 能看到该工作空间（推荐）；B. 只有 `workspace.manage`。
- **Q5 开始任务时能看到团队里未关联的工作空间吗**：A. 能，选了就当场关联（推荐）；B. 只能选已关联的，要先去设置里关联。
- **Q6 改动页对别的项目的会话**：A. 只显示数量（推荐）；B. 完全隐藏；C. 有权限就显示。
- **Q7 迁移后同一目录的重复 clone**：A. 不动；B. 运营后台列出同仓库的多份副本，人工合并（推荐 A）。

## 定稿（2026-11-02 David）

- Q1 → A：顶部导航「项目」旁边新增「工作空间」。
- Q2 → A：允许没关联任何项目的工作空间。
- Q3 → B：git 仓库配方放在工作空间上（记 `repoUrl`）；项目的仓库只作为新建工作空间时的默认值。
- Q4 → A：有项目 `project.update`（项目管理）权限、并且看得到该工作空间的人可以关联。
- Q5 → B：开始任务**只能**选已关联的；没有关联时给「关联工作空间…」入口，不在选择器里当场关联团队里的其他工作空间。
- Q6 → A：改动页对别的项目的会话只显示数量。
- Q7 → A：迁移不动重复的副本（同一仓库在不同目录的多份 clone 保持各自独立）。完全相同的 (机器, 目录) 登记会合并成一个工作空间、关联到原来的各个项目。
