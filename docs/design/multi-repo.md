# 多仓库项目（polyrepo）：组合工作空间

> 目标：一个项目可以绑定多个 git 仓库；一条会话在一个**组合工作空间**里干活，里面每个子目录是一个单仓库工作空间。单仓库项目仍是「只有一员的特例」，不出现第二条代码路径。

## 0. 结论

- 采用**组合工作空间**（composite workspace）：会话只认一个落点，agent 只有一个 cwd，多个仓库是它下面的子目录 —— 对 agent 来说就是 `cd api/`、`cd web/`。
- 组合工作空间是**独立聚合**，不是被改坏的 `Workspace`：`WorkspaceGroup{root, members[]}`，每个成员仍是现存语义的 `Workspace`（一台机器、一个 checkout、一条分支），建 worktree / 清理 / diff / checkpoint 全部复用。
- 组合里的成员**只能是新建 worktree，并且都建在容器目录内**（`<root>/<repo-name>`）。不复用已有长期空间、不做符号链接 —— 这样「子目录 = 单仓库 checkout」是硬保证，而不是约定。
- 提交与 PR 仍按仓库独立；组合工作空间不做跨仓原子提交。
- 老数据零迁移：`Session.groupId` 新增，null 就是今天的单工作空间路径。

## 1. 为什么这样切

调研（`docs/design/multi-repo.md` 初稿 §1）里已经验证过：VS Code multi-root 是「每 folder 一个终端 + 每仓独立 SCM」，Cursor / Devin / Codex 云端是「平铺 checkout + 绝对路径」，没有一家用符号链接把多仓合成一个根。组合工作空间 = 后者的物理布局 + 前者的独立 SCM 粒度，只是额外给了它一个一等名字和生命周期。

它相对「会话挂 N 个互不相干的 workspace」的好处：

- agent 的心智模型简单：一个根，子目录就是仓库；`ls`、`rg`、`cd` 都能用。
- 终端不需要「切换仓库」——就开在容器根，`cd` 即可；文件树天然是「多仓并列」。
- 会话的落点仍然单值（`groupId`），托管、迁移、清理只需要看一个对象。

代价（必须写进设计，不能假装没有）：

- git / diff / commit / checkpoint 这些「按仓库」的操作要显式带成员 id，不能靠 `root` 猜。
- 容器目录有它自己的生命周期（成员全删了要收掉），清理顺序与今天不同。
- 成员不能复用已有 checkout（否则「子目录」不成立），准备时间与磁盘 ×N。

## 2. 领域模型

```ts
// workspace-group.ts
export interface WorkspaceGroup {
  readonly id: WorkspaceGroupId;          // 'group_<8hex>'
  readonly projectId: ProjectId;
  readonly workerId: string | null;       // 整组必须在一台机器上
  readonly root: string;                  // 容器目录，由 domain 算
  readonly members: readonly WorkspaceGroupMember[];
  readonly state: 'preparing' | 'ready' | 'failed';
  readonly ownerTaskId: TaskId | null;    // 临时组合归任务；长期组合为 null
  readonly createdAt: number;
}

export interface WorkspaceGroupMember {
  readonly workspaceId: WorkspaceId;      // 真实 workspace 行，kind=temporary/source=worktree
  readonly repoId: string;                // 对应 Project.repos[].id
  readonly name: string;                  // 子目录名，= 仓库名
  readonly role: 'primary' | 'attached';
}
```

项目侧：

```ts
export interface ProjectRepo {
  readonly id: string;                    // 'repo_<8hex>'，项目内稳定；改名字不改 id
  readonly name: string;                  // 子目录名候选，`^[a-z][a-z0-9-]{0,40}$`，项目内唯一
  readonly url: string;
  readonly defaultBranch: string | null;
}

export interface Project {
  readonly repos: readonly ProjectRepo[]; // 0..8，空 = 不绑仓库
  ...
}
```

- `Project.repo` 删除，读时派生 `primaryRepo(project) = repos[0] ?? null`；存储把老 `repo_url/repo_default_branch` 读成单成员清单，过渡期双写两列（旧版本回滚仍能跑）。
- `PROJECT_REPOS_MAX = 8`。

会话侧：

```ts
interface Session {
  /** 组合工作空间：非空时整组在 Group 里，workspaceId 指向 primary 成员，只作为兼容与快捷方式。 */
  readonly groupId?: WorkspaceGroupId | null;
  readonly workspaceId: WorkspaceId | null;
}
```

- `locationsOf(deps, project, session)` 返回 `{ root, members[] }`：有 `groupId` 时 root = 容器目录、members = 成员清单；否则就是今天的一个 workspace。`locationOf` 保留为「返回 root」的薄封装。
- 所有按仓库取 root 的下游改成 `memberRoot(group, memberId)`；默认省略 = primary。

## 3. 目录布局

```
<worker root>/agent-hub-groups/<project-slug>/<group-name>/     ← 容器 root（= agent cwd）
├── api/          ← git worktree，分支 agent-hub/<slug>-<4位id>
├── web/          ← git worktree，同一条分支名
└── .agent-hub/group.json   ← 容器标记（不是 git 仓库；文件 API 不列出、git 操作拒绝）
```

- 容器路径由 domain 算（和 worktree 路径一样属于「平台拥有的目录」），落在一个新的 `WORKER_GROUPS_DIR` 下，默认 `<roots[0]>/agent-hub-groups`，必须落在 `WORKER_ROOTS` 内。
- 每个成员用 `git worktree add <container>/<repo-name> -b agent-hub/<slug>-<id>` 建；`ownRepo` 校验不变（它检查的是成员自己的 toplevel）。
- 容器 root 不是 git 仓库：`git status` 在根上会落到错误仓库或报错，所以 **hub 侧任何 git 操作都必须显式带成员 id**，不允许「在 root 上跑 git」。
- 单仓库项目**不建组合**：仍然直接是那一个 worktree（今天的行为），UI 也不显示组合概念。

## 4. 会话怎么工作

- `start_session` 的 `workspaceRoot` = 容器 root；任务背景注入成员清单：

  ```
  这个项目有三个仓库，都在 /…/groups/acme/issue-42/ 下：
  api（主仓库）  web  proto
  每个子目录是一个独立 git worktree，分支都是 agent-hub/issue-42-7f3a。
  ```

- 终端：cwd = 容器 root，一个会话一个终端不变；`cd api` 即可。
- 文件页：根是容器，树里就是成员目录；`directoryScope` 仍按 groupId 分键。
- 改动页：按成员分组（`api（3）`、`web（1）`），详情走单成员的 files/diff 接口。
- 提交 / 推送 / PR：一次一个成员，入口带成员切换。
- checkpoint / rewind：每个成员各存一份 checkpoint ref；rewind 逐个恢复，部分失败明确报「api 已恢复、web 失败：…」。
- 准备命令：每个成员各跑一次（cwd = 成员目录，`AGENT_HUB_REPO=<name>`），并行；primary 失败拦派发，附成员失败只警告并写进任务背景。
- `agent.spawn`：继承同一个 group（或 `workspace_mode: 'isolated'` 时新建一组），不允许兄弟会话只挂半组。

## 5. 生命周期与清理

- 建组：先校验所有仓库与目标机器（同一台）、再按成员顺序建 worktree + 跑准备命令；任一失败 → 该成员 `failed`，整组 `failed`，已建成的成员保留待重试（`retryWorkspaceGroupUseCase` 只重试失败成员）。
- 收组：所有成员都满足现有 `unsavedReason`/`protectedReason` 才收；任一有脏改动则整组 `kept`（不要出现「api 删了 web 还在」的半组状态）。
- 活动判定沿用 W3：组内任一会话 running、或任一成员还有 live terminal，就不清。
- 孤儿扫描：容器目录按 `WORKER_GROUPS_DIR` 前缀识别；容器存在但组行不在 → 逐个成员走现有孤儿逻辑（成员路径在容器内，`ownRepo` 仍成立）。

## 6. 权限与审计

- 仓库清单是项目配置：`project.update` 改、`project.read` 看。
- 建组按 `workspace.create`；成员继承项目团队边界。
- 审计：`project.repos`、`workspace.group.create`、`workspace.group.remove`。

## 7. 前端

- 项目设置 → 「仓库」：增删改（名字/URL/默认分支），提示「只影响之后新建的组合工作空间」。
- 派生对话框 → 工作空间选项：单仓库项目仍是「新建 worktree」；多仓库项目多一项「**新建组合工作空间（N 个仓库）**」，展开后列出会被建的子目录与分支，默认选中；「已有工作空间」列表只列单仓库空间（组合不能再嵌套）。
- 会话页：只有 `groupId` 时显示一行「组合 · N 个仓库」，改动页分组；单仓库项目零变化。

## 8. 分期

| 期 | 内容 | 估时 |
| --- | --- | --- |
| M1 | 领域与存储：`Project.repos`、`WorkspaceGroup` + 成员、`locationsOf`、老数据派生与双写、单测 | 1.5 天 |
| M2 | 运行时：建组 / 重试 / 收组、`start_session` 容器 root + 背景注入、worker 建成员 worktree、准备命令并行 | 1.5 天 |
| M3 | 按成员的 git/文件/checkpoint/rewind 接口与 `workspaceId` 参数 | 1 天 |
| M4 | 前端：项目仓库设置、派生对话框组合项、改动页分组、提交成员切换 | 1.5 天 |
| M5 | e2e：两仓项目 → 会话改两处 → 分别提交 → 收组；失败上下文 | 0.5 天 |

约 6 天。M1–M2 完成后即可「后端能跑、前端只认 primary」，M4 补齐体验。

## 9. 不做什么

- 不做符号链接 / 虚拟文件系统聚合。
- 不做「组合里复用已有长期工作空间」（子目录必须是本组新建的 worktree）。
- 不做跨仓原子提交、跨仓单 PR。
- 不做运行中给已有组合追加仓库（要改就新开一组）。
- 不做组合嵌套（组合里不能再放组合）。
- 单仓库项目不创建组合，保持现状。

## 10. 已拍板

1. **容器位置（已定）**：统一容器目录 `<roots[0]>/agent-hub-groups/<project-slug>/<group-name>/`，成员都在里面；孤儿扫描只认这个前缀。
2. **默认勾选（已定）**：多仓项目派生时默认全选；逐仓可以取消（取消的仓库这次不建）。
3. **分支名（按推荐执行）**：所有成员用同一 slug `agent-hub/<slug>-<4位id>`，PR 之间能对上。
