# 工作空间（Workspace）设计

> 状态：提案，待评审。只是设计，不含代码改动。

## 1. 问题

现在一个 Project 绑着一个 `rootPath`（外加一个 `workerId`），目录是在创建项目时用 DirectoryPicker 选的。用户的诉求有两条：

1. **选目录要收敛**：默认在「这个项目专属的目录」里选，并且能直接新建文件夹。
2. **抽象出工作空间**：项目和工作空间解耦、多对多。一个项目可以用多个工作空间（不同机器上的仓库或目录），一个工作空间也可以被多个项目共用。

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

**共识**：执行位置（机器 + 目录）是一等实体，可复用、可管理；会话总是落在一个具体的位置上；多根是「一个主根 + 附加根」，而不是平等的多根；归属和权限挂在这个实体上。

## 4. 推荐领域模型

### 实体

```
Workspace（工作空间）     一台机器上的一个目录，是一等聚合
  id, name, workerId (非 null), root (绝对路径), kind: 'managed' | 'linked'
  ownerId, createdAt, archivedAt?

Project（项目）           目标、任务、画布的作用域容器，不再持有路径
  id, name, ownerId, createdAt

ProjectWorkspace（关联）   多对多
  projectId, workspaceId, isDefault, addedAt
  （label 可选；不同机器上的同一仓库可以用同一个 label 标成「同一份代码」）

Session                   增加 workspaceId（必填，创建时定下，不可变）
  workerId 由 workspace.workerId 决定
```

- `managed`：hub 托管的项目专属目录，位于 `<WORKER_ROOTS[0]>/agent-hub/<project-slug>/`，由 hub 新建。
- `linked`：用户指向的一个已有目录，比如已有的仓库。

### 不变量（domain 强制执行）

1. `workspace.root` 必须是绝对路径，并且落在该 Worker 的 WORKER_ROOTS 之内。校验通过端口 `WorkspaceFS`（Worker 侧）完成，领域层不做 I/O。
2. 同一个 `(workerId, normalize(root))` 只能有一个 Workspace，所以共享是共享同一个实体，而不是复制一份。
3. 一个项目至少有一个 Workspace，并且恰好有一个默认的。
4. Session 的 `(projectId 经 task, workspaceId)` 必须在关联表里；会话一旦创建，workspace 不可变。
5. **换机器继续 = fork 到另一个 Workspace**（该项目里在目标机器上的那个 workspace；没有就当场新建或关联一个），不再改项目的副作用字段。
6. 不能删除还有活跃会话的 Workspace，只能归档；解除关联时，该项目在这个 workspace 上的历史会话仍保留（只读）。
7. 权限：能在某个 Workspace 上开会话 ⇔ 是该 workspace 的所有者或被授权的成员，并且是项目成员；Owner 拥有全部权限。

### 和其它能力的关系

| 能力 | 新规则 |
|---|---|
| 多 Worker | 会话的 worker = workspace.workerId；placement 只在「该项目的、所在机器在线的 workspace」里选 |
| WORKER_ROOTS | 是 workspace.root 的硬边界；managed 目录默认建在 roots[0] 下 |
| 换机器继续 | 选目标 workspace（列出该项目在目标机器上的 workspace，加「在那台机器上新建或关联」） |
| `@file` 引用 | 以会话的 workspace 为根；以后若支持附加目录，用 `名字:路径` 的写法区分 |
| 附件 | 移出用户仓库：Worker 侧 `<roots[0]>/agent-hub/.attachments/<session>/`（或 hub 的数据目录），经 `resource_link` 传给 agent |
| 画布 | 仍按项目；会话卡片显示 `机器 · 工作空间名` 的徽标，可按 workspace 过滤 |
| 账号 | workspace.ownerId；创建 linked workspace 受「成员可添加机器 / 目录」的设置约束；运营后台里增加工作空间页 |

### 六边形落地

- **domain**：`workspace.ts`（实体和 `createWorkspace`、`linkWorkspace`）；端口 `WorkspaceRepository`、`ProjectWorkspaceRepository`；`WorkspaceFS` 扩展 `mkdir`（受 roots 约束）。
- 删掉 `project.rootPath / workerId / directories` 和 `workspaceFor`。
- **contract**：`workspaceSchema`、`createWorkspaceRequest {projectId?, workerId, mode:'managed'|'link', path?|name?}`、`mkdirCommand`（wire）。
- **storage**：表 `workspaces`、`project_workspaces`；`sessions.workspace_id`。
- **worker**：新增 `mkdir` 命令，路径必须在 roots 内，不允许 `..`，只建一层。

## 5. 目录选择器重做

### 原则：默认不选目录，要选也只在边界内选

新建项目的流程（桌面和手机一致，单列）：

1. 填项目名称（必填）。
2. 选「在哪台机器」：默认本机或上次用的那台，用分段控件或下拉。
3. 选「目录」，三个选项卡片，默认是第一个：
   - **新建专属目录（推荐）**：显示预览 `~/agent-hub/<slug>`，不需要浏览。
   - **用已有工作空间**：列出该机器上已有的 workspace（可共享的），点一下即选。
   - **选择已有目录**：打开浏览器。
4. 「创建」。

浏览器（只在需要时打开）：
- 顶部用**面包屑**代替可编辑输入框（「手动输入路径」收进一个次要的 ⋯ 菜单）；根节点就是 WORKER_ROOTS，不能越界。
- 列表**单击进入**；底部固定一个主按钮「选择 <当前目录名>」，不再用双击。
- 「＋ 新建文件夹」用行内输入，回车创建并进入。
- 标出 git 仓库（⎇ 图标），按最近使用排序置顶；隐藏目录用一个开关显示。
- 手机：全屏 sheet，行高 ≥ 44px，主按钮固定在底部的安全区之上。

换机器继续时复用同一个组件，模式为「选目标工作空间」。

## 6. 数据迁移

一次性、幂等的迁移，启动时在 storage 层完成：

1. 每个项目：用 `(project.workerId ?? 本机 workerId, rootPath)` 查找或创建一个 Workspace（kind=`linked`，owner = 第一个 Owner），作为该项目的默认关联。
   - 老数据里 `workerId = null` 的，解析为当时的本机 Worker id（在 worker 首次上线时补齐；补齐之前，用占位值 `local` 解析）。
2. 每个 `directories[w] = p`：查找或创建 Workspace(w, p) 并加入关联（非默认）。
3. 每个 session：先按 `session.workerId` 匹配该项目的 workspace，匹配不到就用默认的；写入 `workspace_id`。
4. 旧列保留一个版本（只读，作为回滚依据），下个版本再删。
5. 附件：新附件走新位置，老附件保持原地（链接仍然有效）。

## 7. 分阶段实施

| 阶段 | 内容 | 可独立上线 |
|---|---|---|
| P1 | Worker `mkdir` 命令和边界校验；选择器重做（面包屑、新建文件夹、单击进入 + 底部按钮、手机 sheet）；建项目默认「新建专属目录」 | ✅ 不动模型，最先回应用户 |
| P2 | 领域引入 Workspace 实体、表和迁移；Project 去掉路径字段；session.workspaceId；API 兼容层（旧字段从默认 workspace 推导） | ✅ |
| P3 | 多对多 UI：项目设置里的「工作空间」列表（添加、关联已有、设为默认、解除）；新建会话时选 workspace；会话卡片徽标 | ✅ |
| P4 | 换机器继续改为选目标 workspace；附件迁出仓库 | ✅ |
| P5 | 权限：workspace owner 和授权；运营后台加工作空间页；和「成员可添加机器」联动 | 和账号第四阶段一起 |

## 8. 待定问题与建议

1. **一条会话能不能跨多个 workspace（多根）？** 建议**先不支持**：一条会话只有一个 workspace。以后需要时，再给 session 加 `extraWorkspaceIds`（必须在同一台 Worker 上），对应 Claude 的 `--add-dir`。
2. **专属目录放在哪？** 建议 `<roots[0]>/agent-hub/<slug>`，并且可以按 Worker 配置（`WORKER_MANAGED_DIR`）；slug 冲突时追加 `-2`。
3. **新建的专属目录要不要 `git init`？** 建议提供一个选项，默认勾选，因为 agent 的 diff 和回滚依赖 git。
4. **删除项目时要不要删 managed 目录？** 建议默认不删，只解除关联；在运营后台里单独提供「清理无主工作空间」。
5. **共享 workspace 的并发冲突**（两个项目的 agent 同时写同一个目录）：建议在会话启动时提示「该工作空间上已有 N 个运行中的会话」；以后再考虑 git worktree 隔离（每条会话一个 worktree，类似 Codex/Devin）。
6. **「同一份代码在不同机器上」怎么表达？** 建议先用关联上的 label，不建模「仓库」实体；以后如果做 git 同步，再引入 Repo。
7. **成员能不能关联任意目录？** 建议受 WORKER_ROOTS 和设置开关约束；成员默认只能新建 managed 目录。
