# 工作空间（Workspace）设计

> 状态：提案（已按评审决定修订）。只是设计，不含代码改动。
>
> 已定：①一条会话只用一个工作空间；②项目可以绑定 git 仓库；③删除项目不删目录；④一个目录只属于一个项目；⑤成员默认只能用托管目录；⑥项目不绑定 Worker，执行任务时才选 Worker；⑦Task 是一等实体（画布卡片 = 任务）；git 项目每个任务一个 worktree 和分支；⑧采纳第二轮待定问题的建议（见 §8）。

## 1. 问题

现在一个 Project 绑着一个 `rootPath`（外加一个 `workerId`），目录是在创建项目时用 DirectoryPicker 选的。用户的诉求有两条：

1. **选目录要收敛**：默认在「这个项目专属的目录」里选，并且能直接新建文件夹。
2. **抽象出工作空间**：项目和目录解耦。项目是逻辑上的东西，目录只在执行时落到某台 Worker 上。（最初设想过多对多，评审后定为一对多。）

## 2. 现状梳理（读代码得出）

| 位置 | 现状 |
|---|---|
| `packages/domain/src/project.ts` | `Project { rootPath, workerId, directories: Record<workerId, path> }`。这里已经有一个名叫 `Workspace { workerId, root }` 的值对象，用 `workspaceFor(project, sessionWorker)` 推导出来 |
| `use-cases/projects.ts` | `createProjectUseCase` 只校验「目录存在」。`browseDirectories` 从 home 或 `roots[0]` 起步，到 WORKER_ROOTS 边界就不再给「上一级」 |
| `use-cases/continue-elsewhere.ts` | 换机器继续时，如果目标机器没有登记目录，就要求人来选，然后把选的目录写进 `project.directories[workerId]` |
| `apps/web/src/directory-picker.tsx` | 嵌入式面板：一个路径输入框、↑、子目录列表；双击选中，或点「用这个目录」；不能新建；隐藏以点开头的目录 |
| `apps/web/src/home.tsx` | 建项目的流程是先选 Worker，再浏览选目录，再自动取名 |
| `apps/worker/src/main.ts` | `WORKER_ROOTS` 既是起点又是边界（remote 机器强制） |
| storage | `projects` 表里有 root_path、worker_id、directories(JSON)；sessions.worker_id；layout 按 project_id 存；附件落在 `<项目目录>/.agent-hub/attachments/<session>/` |
| 账号 | 项目还没有归属人或成员的概念 |

### 具体问题

1. **同一个概念散落在三个地方**：`rootPath + workerId` 是「主目录」，`directories` 是「别处的副本」，`Workspace` 却只是推导出来的值。三者语义重叠，解析规则（家机器 / null = 本机 / 登记表）分别藏在 `workspaceFor` 和 `continueElsewhereUseCase` 两处，而且不完全一致：后者把 null 解释成「本机 Worker」。
2. **`workerId = null` 的歧义**：它既表示「Server 本机」，又表示「多机之前的老数据」。
3. **目录选择没有默认落点**：从 `$HOME` 或 `roots[0]` 开始逛整棵树，容易选错，也容易把 agent 放进过大的目录（比如 `$HOME`）。
4. **不能新建目录**：从零开始的新项目只能先去机器上 `mkdir`。
5. **交互混乱**：输入框既显示路径又能手打；单击进入、双击选中，手机上没有双击；「用这个目录」要等输入和列表对齐才能点；隐藏目录只能手打。
6. **换机器继续时临时选目录**，结果作为副作用写进项目，用户感知不到，也没法管理或解绑。
7. **附件写进用户仓库**（`.agent-hub/attachments`），会污染 git 工作区；共享目录时会混在一起。
8. **没有权限边界**：进入多账号后，谁能在哪台机器的哪个目录上跑 agent，没有任何模型来表达。
9. 画布布局按项目存，和目录无关，这一点是对的；但会话卡片看不出它在哪台机器、哪个目录上干活。

## 3. 同类产品调研

| 产品 | 模型 | 可借鉴 |
|---|---|---|
| **VS Code / Cursor 多根工作区** | `.code-workspace` 文件 = 多个 folder，加上共享设置；一个 folder 可以出现在多个 workspace 里 | 「工作区 = 一组根目录」，多对多是天然的；`@file` 跨根时用 `根名/路径` 来区分 |
| **OpenCode（web / serve）** | 以目录为单位起 server，会话属于目录（project = git 根），没有多对多 | 会话直接绑目录，简单；项目就是目录的身份 |
| **Claude Code** | 「项目」就是 cwd，会话历史按目录存（`~/.claude/projects/<路径编码>`）；可以 `--add-dir` 追加目录 | 一条会话有一个主目录加若干附加目录 |
| **Codex cloud** | Environment = 仓库 + 镜像/setup 脚本；任务选一个 environment，在隔离容器里跑并产出 diff | 「环境」是可复用的执行配置，和任务解耦 |
| **Devin** | 每个会话一台 VM；仓库通过「Machine snapshot」预先配置；Playbook/Knowledge 归组织 | 执行环境是模板化、可共享的 |
| **GitHub Codespaces** | codespace = 仓库某分支 + devcontainer，属于某个用户；一个仓库可以有多个 codespace | 「工作空间实例」有归属人，生命周期可管理（停止、删除） |
| **Coder** | Template → Workspace（属于某个用户，可以 start/stop）；ACL 在 template 和组织上 | 管理员管模板和权限，用户在边界内自助创建 |
| **Zed（remote/ssh）** | 项目 = 一台机器上的若干 worktree；远程项目绑定 ssh host | 「机器 + 若干目录」是一个整体 |
| **JetBrains Gateway** | 连接 = 主机 + 项目目录，IDE 后端跑在远端 | 选目录发生在「选主机之后」，并且有最近使用列表 |

**共识**：执行位置（机器 + 目录）是一等实体，按需创建；会话总是落在一个具体的位置上；仓库或环境作为「怎么把代码放到那台机器上」的配方挂在项目上（Codex environment、Codespaces、Coder template）。

## 4. 推荐领域模型

### 核心思路

- **项目**回答「做什么的范围」：名称、可选 git 仓库、画布。
- **任务**回答「做哪件事」：一张画布卡片，描述目标，不绑定机器。
- **会话**回答「谁在哪儿做」：一次 agent 运行，绑定一台 Worker 和一个具体目录（git 项目里是该任务的 worktree）。

### 实体与关系

```
Project 1──N Task 1──N Session
   │                     │
   └─1──N Workspace 1──N TaskCheckout ──1 Session 使用 1 个
```

```
Project（聚合根）       id, name, ownerId, repo?{url, defaultBranch}, createdAt
                        不绑定 Worker，不持有路径

Task                   id, projectId, title, goal, status, branch?（git 项目：agent-hub/<task-slug>，首次运行时定下）
                        画布卡片就是任务；不绑定 Worker

Workspace              id, projectId, workerId, root, kind:'managed'|'linked', isGit, state:'preparing'|'ready'|'failed', archivedAt?
                        项目在某台 Worker 上的主目录（git 项目里是主 clone）

TaskCheckout           id, taskId, workspaceId, path, state, removedAt?
                        git 工作空间：path = <root>/../.worktrees/<slug>/<task-slug>，一个 git worktree，检出 task.branch
                        非 git 工作空间：path = workspace.root（没有隔离）

Session                id, taskId, checkoutId（必填、不可变）, workerId（= checkout 所在 workspace 的 worker）, agent, model, status…
                        重试、换模型、换机器继续都是同一个任务下的新会话
```

### 不变量

1. **一个目录只属于一个项目**：`(workerId, root)` 全局唯一，并且不能互相嵌套。
2. **每个项目在每台 Worker 上最多一个活跃工作空间**。
3. 所有路径（root、worktree）都在 WORKER_ROOTS 之内。
4. **会话只用一个 checkout**，创建后不可变；会话的 worker 由 checkout 决定。
5. **每个任务同时最多一个运行中的会话**：要换模型或换机器，先停掉当前会话，或者从它 fork。
6. **git 工作空间**：每个任务在每个工作空间里最多一个 checkout（worktree），它检出 `task.branch`；同一个分支不会同时出现在两个 worktree 里（git 自身也强制这一点）。
7. **非 git 工作空间**：同一时间最多一个「写入中」的任务。别的任务要在这里运行时，进入排队，或者由用户确认后并发（显示警告）。
8. **删除项目不删目录**，只归档；归档的目录只有 Owner 能「释放」给别的项目使用。
9. 成员默认只能用托管目录；关联已有目录需要 Owner，或者开启对应设置。

### 解析执行位置：`prepareRun(task, workerId)`

1. **工作空间**：这个项目在这台 Worker 上的工作空间；没有就提议新建托管目录 `<roots[0]>/agent-hub/<project-slug>`（slug 首次创建时固定，冲突追加 `-2`）。有 repo 就 `git clone`，没有就 `mkdir` 加 `git init`（默认勾选）。用户也可以改为在 WORKER_ROOTS 内选已有目录。
2. **checkout**：
   - git 工作空间：找该任务在这里的 worktree；没有就 `git fetch`，然后 `git worktree add <path> -b <task.branch> <base>`。如果远端已经有 `task.branch`（比如在别的机器上推过），就基于 `origin/<task.branch>` 检出；否则基于 `origin/<defaultBranch>`，没有 remote 时基于本地 HEAD。
   - 非 git 工作空间：checkout = root，并检查不变量 7。
3. 这一步是准备中的状态，进度在任务卡片上显示，ready 之后才启动会话。
4. clone、fetch、push 都用 **Worker 本机已有的 git 凭据**，hub 不保存 token。

### 结束任务

- **合并**：在 Worker 上把 `task.branch` 合并进默认分支（快进或 merge commit），然后可以推送。
- **PR**：推送 `task.branch` 到 remote，然后给出创建 PR 的链接（GitHub 的 compare URL）；自动创建 PR 作为以后的增强。
- **放弃**：任务标记为放弃；分支保留。
- **清理策略**：任务完成或放弃，并且分支已合并或已推送之后，删除 worktree（`git worktree remove`，分支保留）；未推送、未合并的 worktree 不自动删，只在项目设置里标出「可清理」；运营后台提供批量清理；N 天（默认 14）没有活动的已完成任务自动清理（只清理已推送或已合并的）。

### 换机器继续

同一个任务，在另一台 Worker 上开新会话：

1. 当前会话如果还在运行，先停掉（不变量 5）。
2. 源机器：把 `task.branch` 上未提交的改动做一次 WIP 提交，然后 `git push origin task.branch`。
3. 目标机器：`prepareRun`，解析或 clone 工作空间，然后从 `origin/task.branch` 建 worktree。
4. 在目标 checkout 上 fork 出新会话（带上对话上下文，agent 的 resume 不可用，所以是新开的会话）。

**没有 remote 的限制**：项目没有 repo，或者 repo 没有 remote 时，代码没法在机器之间传递。目标机器上只能从空目录或已有目录开始，界面明确提示「改动留在原机器上」。以后可以考虑 hub 中转 `git bundle`（待定问题 1）。

### 和其它能力的关系

| 能力 | 规则 |
|---|---|
| 画布 | 卡片 = 任务；卡片上显示最近一次会话的状态，以及「机器 · 分支」 |
| `@file` | 以会话的 checkout 为根 |
| 附件 | 移出仓库：`<roots[0]>/agent-hub/.attachments/<session>/` |
| 账号 | 项目 ownerId；任务和工作空间沿用项目的权限，加上不变量 9 |
| 运营后台 | 工作空间和 worktree 列表、迁移冲突、释放归档目录、批量清理 |

### 六边形落地

- **domain**：新增 `workspace.ts`、`checkout.ts`；用例 `prepareRun`、`finishTask`、`continueElsewhere`（重写）、`cleanupCheckouts`；端口 `WorkspaceRepository`、`CheckoutRepository`；新增端口 `WorkspaceVcs`（clone、fetch、worktreeAdd、worktreeRemove、commitWip、push、merge、status），由 Worker 实现，hub 经 gateway 调用。
- Project 删掉 `rootPath / workerId / directories` 和 `workspaceFor`；Task 加 `branch?`。
- **contract**：project 加 `repo?`；`workspaceSchema`、`checkoutSchema`；`runTaskRequest {workerId, location?: 'auto' | {linkPath}}`；wire 加 `mkdir`、`git.*` 命令（clone 和 fetch 用流式进度帧）。
- **storage**：表 `workspaces`、`checkouts`；`projects.repo_url/repo_branch`；`tasks.branch`；`sessions.checkout_id`；唯一索引按照不变量 1、2、6。
- **worker**：`git` 子进程实现，所有路径都校验在 roots 内。

## 5. 交互流程

### 新建项目

名称加可选的 git 仓库（URL、默认分支），然后「创建」。不选机器，不选目录。

### 新建任务（画布上加卡片）

标题和目标，然后「创建」。不选机器。卡片的初始状态是「未开始」。

### 运行任务（卡片上的「运行」）

1. Agent 和模型。
2. **机器**：默认是该项目上次用的那台，没有就用本机；离线的置灰。
3. **位置**：自动解析成一行摘要，可以展开修改：
   - `本机 · foo · 分支 agent-hub/fix-login（新 worktree）`
   - `将 clone foo 到 ~/agent-hub/foo，再建 worktree`
   - 非 git：`~/agent-hub/foo（另一个任务正在写入，将排队）`
   - 展开后可以「选已有目录…」（只在该项目在这台机器上还没有工作空间时出现）。
4. 「运行」。准备进度显示在卡片上。

任务已有运行中的会话时，「运行」变成「停止」；会话结束后，卡片上可以重试、换模型、换机器继续、合并 / PR、放弃。

### 目录选择器（只用于「选已有目录」）

- 起点是该项目的托管目录（不存在就是 roots[0]/agent-hub）。
- 面包屑导航，根是 WORKER_ROOTS；手动输入路径收进 ⋯ 菜单。
- 单击进入，底部固定「使用 <目录名>」按钮。
- 可以 ＋ 新建文件夹（行内输入）。
- 被其他项目占用的目录置灰并标明属于哪个项目；git 仓库标 ⎇。
- 手机：全屏 sheet，行高 ≥ 44px。

### 项目设置

- 仓库：可以编辑。
- 工作空间：按机器列出，可以归档。
- worktree：按任务列出，显示状态（已推送 / 已合并 / 有未提交改动），可以清理。

## 6. 数据迁移

一次性、幂等的迁移：

1. **工作空间**：每个项目的 `(workerId ?? 本机, rootPath)` 和 `directories[w]` 转成 linked 工作空间；是否是 git 仓库由 Worker 上线时探测，补写 `isGit`。冲突时先到先得，其余在运营后台标记。
2. **任务**：现有数据里会话本来就挂在任务下，任务保持不变。如果有会话没有任务（防御性检查），就为每条这样的会话建一个任务（标题取会话标题）。
3. **checkout**：老会话一律挂到「legacy checkout」，path = 工作空间的 root，不建 worktree；它们在工作空间根目录上继续运行（行为和现在一样）。任务**下一次**在 git 工作空间上运行时，才建 worktree 和分支。
4. **repo 建议**：读取 git origin，在项目设置里提示是否绑定，不自动绑定。
5. 旧列保留一个版本作为回滚依据。

## 7. 分阶段实施

| 阶段 | 内容 |
|---|---|
| P1 | 选择器重做；Worker `mkdir`（受 roots 约束） |
| P2 | Workspace 和 Checkout 模型、迁移（legacy checkout）；Project 去掉路径；会话改用 checkoutId；新建项目和运行任务的新流程（无 git 能力：checkout = root 并做排队检查） |
| P3 | git worktree：任务分支、worktree 的创建和复用、每个任务一个运行中会话 |
| P4 | 项目 repo：clone、fetch、准备中的状态和进度；迁移时的 repo 建议 |
| P5 | 结束任务：合并、推送并给出 PR 链接、放弃；worktree 清理策略和后台批量清理 |
| P6 | 换机器继续：WIP 提交、push，在目标机器上 worktree 检出任务分支并 fork；附件迁出仓库 |
| P7 | 权限：成员只能用托管目录；运营后台的工作空间和冲突管理 |

## 8. 已定与待定

**已定（采纳上一轮的建议）**：用 Worker 本机的 git 凭据；托管目录名在首次创建时固定，冲突追加 `-2`；归档目录只有 Owner 能释放；linked 目录的 remote 和项目 repo 不一致时只警告；无仓库的新托管目录默认 `git init`；会话只用一个目录；删除项目不删目录；成员默认只能用托管目录。

**第三轮已定**：

1. 没有 remote 时**不做** hub 中转 git bundle，只提示限制。
2. 任务分支命名为 `agent-hub/<slug>-<短 id>`。
3. worktree 放在仓库旁边的 `.worktrees` 目录（仓库外的兄弟目录）。
4. 合并时默认 squash。
5. 自动创建 PR 是可选能力，以后再做。

目前没有待定问题。
