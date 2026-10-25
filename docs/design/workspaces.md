# 工作空间（Workspace）设计

> 状态：提案（已按评审决定修订）。只是设计，不含代码改动。
>
> 已定：①一条会话只用一个工作空间；②项目可以绑定 git 仓库；③删除项目不删目录；④一个目录只属于一个项目；⑤成员默认只能用托管目录；⑥项目不绑定 Worker，执行任务时才选 Worker。

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

**项目是逻辑的，Worker 是执行时才选的。** 项目只回答「做什么」：名称、可选的 git 仓库、画布、任务和会话。真正动手时才回答「在哪做」：先选 Worker，再在那台机器上解析出这个项目的工作空间。

### 实体

```
Project（项目，聚合根）       不绑定 Worker，不持有路径
  id, name, ownerId, createdAt
  repo?: { url, defaultBranch }        可选的 git 仓库

Workspace（工作空间）         某个项目在某台 Worker 上的目录；一对多属于 Project
  id, projectId, workerId, root (绝对路径)
  kind: 'managed'               hub 托管目录 <roots[0]>/agent-hub/<slug>，hub 创建（有 repo 就 clone）
      | 'linked'                用户在 WORKER_ROOTS 内选的已有目录
  createdAt, archivedAt?

Session                        增加 workspaceId（必填，创建时确定，不可变）
  workerId = workspace.workerId
```

关系：`Project 1 —— N Workspace`；`Workspace 1 —— N Session`。没有关联表。

### 不变量（domain 强制执行）

1. **一个目录只属于一个项目**：`(workerId, normalize(root))` 全局唯一。另外，不能出现一个工作空间的目录嵌套在另一个工作空间里（祖先或后代）。
2. **每个项目在每台 Worker 上最多一个活跃工作空间**：`(projectId, workerId)` 在未归档的记录中唯一，所以「项目 + Worker → 目录」是确定的。
3. `root` 是绝对路径，并且落在那台 Worker 的 WORKER_ROOTS 之内。校验经 `WorkspaceFS` 端口在 Worker 侧完成，领域层不做 I/O。
4. **一条会话只用一个工作空间**，创建后不可变；会话的 worker = workspace.workerId。
5. **删除项目不删目录**：项目删除或归档后，它的工作空间只做归档标记，磁盘上的目录原样保留；目录不能直接被别的项目接管，需要 Owner 在运营后台显式「释放」。
6. 有运行中会话的工作空间不能归档。
7. 项目绑定了 repo 时，在新机器上自动创建的托管工作空间等于 `git clone --branch <defaultBranch> <url> <managedDir>`；linked 工作空间不强制和 repo 一致，只做提示（remote 不匹配时给出警告）。
8. 权限（P5）：成员默认只能用托管目录（新建或 clone）；linked（选已有目录）需要 Owner，或者开启「成员可关联目录」设置。

### 解析工作空间：`resolveWorkspace(project, workerId)`

纯领域决策加端口执行，返回三种结果之一：

1. **已有**：该项目在这台 Worker 上有活跃工作空间，直接用。
2. **可自动创建**：没有工作空间，就提议托管目录 `<roots[0]>/agent-hub/<slug>`。有 repo 就 clone，否则 mkdir（可选 `git init`）。需要用户确认一次（显示目标路径）。
3. **用户选择**：用户改为「选已有目录」，在 WORKER_ROOTS 内选择，并通过不变量 1 的校验。

在 hub 里，clone 是一个**准备中的状态**：Workspace 有 `state: 'preparing' | 'ready' | 'failed'`，会话等它进入 ready 后才启动，clone 的进度在会话卡片上显示。

### 和其它能力的关系

| 能力 | 新规则 |
|---|---|
| 多 Worker | 选 Worker 在开会话或开任务时发生；默认是该项目上次用的 Worker，没有就用本机 |
| WORKER_ROOTS | 是 root 的硬边界；托管目录建在 roots[0]/agent-hub 下（可用 `WORKER_MANAGED_DIR` 覆盖） |
| 换机器继续 | 同一个项目，换一台 Worker：resolveWorkspace（已有 / 托管 + clone / 选目录），然后在新工作空间上 fork 会话。项目本身没有副作用 |
| `@file` | 以会话的工作空间为根 |
| 附件 | 移出用户仓库：`<roots[0]>/agent-hub/.attachments/<session>/` |
| 画布 | 按项目；会话卡片显示「机器 · 目录名」的徽标 |
| 账号 | 项目 ownerId；工作空间的权限沿用项目的权限，并受成员规则（不变量 8）约束 |
| git 凭据 | clone 用 Worker 本机的 git 凭据（ssh-agent / credential helper），hub 不保存仓库凭据 |

### 六边形落地

- **domain**：`workspace.ts`（实体、`resolveWorkspace`、校验）；端口 `WorkspaceRepository`；`WorkspaceFS` 扩展 `mkdir`、`clone`、`gitRemote`（都受 roots 约束）。
- Project 删掉 `rootPath / workerId / directories` 和 `workspaceFor`，加上 `repo?`。
- **contract**：`projectSchema` 加 `repo?`；`workspaceSchema`；`startSessionRequest` 加 `{workerId, workspace: {mode:'auto'} | {mode:'existing', id} | {mode:'link', path}}`；wire 加 `mkdir`、`clone` 命令（clone 用流式进度帧）。
- **storage**：新表 `workspaces(id, project_id, worker_id, root, kind, state, created_at, archived_at)`，加唯一索引 `(worker_id, root)` 和部分唯一索引 `(project_id, worker_id) WHERE archived_at IS NULL`；`projects` 加 `repo_url`、`repo_branch`；`sessions` 加 `workspace_id`。
- **worker**：实现 `mkdir` 和 `clone`（`git` 子进程，路径必须在 roots 内，禁止 `..`）。

## 5. 交互流程

### 新建项目（不需要选机器）

1. 项目名称（必填）。
2. git 仓库（可选，折叠项）：URL 和默认分支（默认 main）。
3. 「创建」。到这里不碰任何目录。

### 新建会话或任务

1. 选 Agent 和模型（同现在）。
2. **在哪台机器**：默认是该项目上次用的那台，没有就用本机；离线的机器置灰。
3. **目录**（自动解析，一行摘要，可以展开修改）：
   - 已有：`本机 · ~/agent-hub/foo`。
   - 没有，项目有 repo：`将 clone 到 ~/agent-hub/foo`。
   - 没有，项目没有 repo：`将新建 ~/agent-hub/foo`。
   - 展开后可以「选已有目录…」，打开目录选择器。
4. 「开始」。

### 目录选择器（只在「选已有目录」时打开）

- **起点是该项目的托管目录**（不存在就是 roots[0]/agent-hub），不再是 $HOME。
- 顶部是**面包屑**，根就是 WORKER_ROOTS，不能越界；手动输入路径收进 ⋯ 菜单。
- **单击进入**；底部固定主按钮「使用 <当前目录名>」，没有双击。
- 「＋ 新建文件夹」用行内输入，回车创建并进入。
- 已被其他项目占用的目录置灰，标出属于哪个项目（不变量 1）；git 仓库标 ⎇；隐藏目录用开关显示。
- 手机：全屏 sheet，行高 ≥ 44px，主按钮固定在底部的安全区之上。

### 换机器继续

「换台机器继续」→ 选目标 Worker → 同样一行显示目录解析的结果（已有 / clone / 新建 / 选目录）→ 「继续」。

### 项目设置

在「工作空间」列表里按机器列出各自的目录、状态，并能归档；可以编辑 repo。

## 6. 数据迁移

一次性、幂等的迁移，启动时在 storage 层完成：

1. 每个项目：`(project.workerId ?? 本机 workerId, rootPath)` 转成一个 Workspace（kind=`linked`，state=`ready`）。
   - 老数据里 `workerId = null` 的，等本机 Worker 首次上线后补成它的 id；补齐之前用占位值 `local` 解析。
2. 每个 `directories[w] = p` 转成 Workspace(project, w, p, linked)。
3. **冲突**（同一个 (worker, root) 被多个项目用了，或者有目录嵌套）：先迁移的项目拿到它；其余项目的这条记录跳过，在运营后台标记「需要处理」，不删除任何数据。
4. 每个 session：用 `(project, session.workerId)` 找到对应的工作空间，写入 `workspace_id`；找不到的就挂在该项目的第一个工作空间上，并标记。
5. repo：如果某个目录是 git 仓库，就读出 `origin` 的 URL，作为 `project.repo` 的**建议值**，在项目设置里提示「是否绑定」，不自动绑定。
6. 旧列保留一个版本（只读，作为回滚依据），下个版本再删。

## 7. 分阶段实施

| 阶段 | 内容 |
|---|---|
| P1 | Worker `mkdir` 命令和边界校验；目录选择器重做（面包屑、新建文件夹、单击进入 + 底部按钮、手机 sheet） |
| P2 | Workspace 实体、表和迁移；Project 去掉路径和 Worker；session.workspaceId；`resolveWorkspace`（已有 / 新建托管目录 / 选目录） |
| P3 | 新流程：新建项目不选机器；新建会话时选机器并解析目录；项目设置里的工作空间列表 |
| P4 | 项目 repo：Worker `clone` 命令和进度；准备中的状态；迁移时给出 repo 建议 |
| P5 | 换机器继续改为走 resolveWorkspace；附件迁出仓库 |
| P6 | 权限：成员只能用托管目录；运营后台显示工作空间和冲突、释放目录（和账号第四阶段一起） |

## 8. 待定问题与建议

1. **私有仓库的凭据**：建议只用 Worker 本机已有的 git 凭据（ssh key 或 credential helper），clone 失败时提示去那台机器上配置；hub 不保存 token。
2. **clone 之后是否自动切分支或建 worktree**？建议先只 clone 默认分支，不自动建分支；按会话建 worktree 以后再说。
3. **托管目录的 slug 冲突或项目改名**：建议 slug 在首次创建时固定，改名不搬目录；冲突时追加 `-2`。
4. **项目删除后目录的「释放」**：建议只有 Owner 能在运营后台释放归档的工作空间，让另一个项目可以使用该目录。
5. **一个项目在一台机器上需要两个目录**（比如两个分支）？按不变量 2 不支持；以后需要时用 worktree，作为同一个工作空间的子概念。
6. **linked 目录的 remote 和项目 repo 不一致时**，只警告还是拒绝？建议只警告。
7. **新建托管目录（无 repo）时是否默认 `git init`**？建议默认勾选。
