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

## 11. 实现规格

### 11.1 领域

新增 `packages/domain/src/workspace-group.ts`：

```ts
export type WorkspaceGroupId = string & { readonly __brand: 'WorkspaceGroupId' };
export interface WorkspaceGroupMember {
  readonly workspaceId: WorkspaceId;
  readonly repoId: string;
  readonly name: string;
  readonly role: 'primary' | 'attached';
}
export interface WorkspaceGroup {
  readonly id: WorkspaceGroupId;
  readonly projectId: ProjectId;
  readonly workerId: string | null;
  readonly root: string;
  readonly members: readonly WorkspaceGroupMember[];
  readonly state: 'preparing' | 'ready' | 'failed';
  readonly ownerTaskId: TaskId | null;
  readonly createdAt: number;
  /** 最近一次准备失败的原因（给人看，不进任务背景）。 */
  readonly error: string | null;
}
export const WORKSPACE_GROUP_MEMBERS_MAX = 8;
export const groupMemberRoot = (group: WorkspaceGroup, workspaceId: WorkspaceId): string | null;
export const primaryMember = (group: WorkspaceGroup): WorkspaceGroupMember | null;
```

- `packages/domain/src/ids.ts` 加 `newWorkspaceGroupId`（`group_<8hex>`）。
- `project.ts`：删 `repo`，加 `repos: readonly ProjectRepo[]`，`ProjectRepo.id`；`primaryRepo(project)`；`normalizeRepos(input)`（数量 0..8、名字唯一且合规、URL 非空、id 缺失时生成）。
- 端口 `packages/domain/src/ports/workspace-groups.ts`：`WorkspaceGroupRepository { byId, listByProject, save, remove }`。
- `use-cases/workspaces.ts`：新增

```ts
export interface SessionLocation {
  readonly root: string;             // 容器根（组合）或空间根
  readonly workerId: string | null;
  readonly group: WorkspaceGroup | null;
  readonly members: readonly { workspaceId: WorkspaceId; name: string; path: string; role: 'primary'|'attached' }[];
}
export async function locationsOf(deps, project, session): Promise<SessionLocation>;
```

`locationOf` 改成 `(await locationsOf(...)).root` 的薄封装，签名不变（15 个调用点先不动）。

### 11.2 存储

- `projects` 加列 `repos TEXT`（JSON 数组）。读：有 `repos` 用之，否则用 `repo_url/repo_default_branch` 拼单成员。写：`repos` 与两列同时写（`repo_url = repos[0].url`）。
- 新表：

```sql
CREATE TABLE workspace_groups (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worker_id TEXT, root TEXT NOT NULL,
  state TEXT NOT NULL, owner_task_id TEXT, error TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE workspace_group_members (
  group_id TEXT NOT NULL, workspace_id TEXT NOT NULL, repo_id TEXT NOT NULL,
  name TEXT NOT NULL, role TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY (group_id, workspace_id)
);
```

- `packages/storage-sqlite/src/workspace-groups.ts`：mapper + 事务里 `save` 覆盖成员表（先 delete 再 insert，组很小）。
- `packages/storage-sqlite/src/mappers.ts` 的 project mapper 兼容旧列。

### 11.3 worker / 契约

- `ws.add_worktree` 已支持 `existing: true` 时用调用方给的绝对路径（跳过 `relocateWorktree`），组合成员直接复用它，不新增建 worktree 的 RPC。
- 新增两个 RPC（`packages/contract/src/worker-methods.ts`）：

```ts
export const wsGroupInit = method('ws.group_init', 'git',
  z.object({ root: z.string(), marker: z.string().max(4000) }),
  z.object({ root: z.string() }));
export const wsGroupRemove = method('ws.group_remove', 'git',
  z.object({ root: z.string() }),
  z.object({ removed: z.boolean() }));
```

  - `ws.group_init`：`guard(root)` → `mkdir -p root/.agent-hub` → 写 `group.json`（写到临时文件再 rename）→ 目录已存在且非空则 `conflict`。
  - `ws.group_remove`：只允许删 `WORKER_GROUPS_DIR` 前缀下的目录；删前 `lstat` 不再跟随符号链接。
- 节点侧：`packages/node-gateway/src/group-dir.ts`（两个方法的实现），`server-gateway.ts` 超时 120s。
- 准备命令复用 `ws.run_setup`，`env` 加 `AGENT_HUB_REPO`。

### 11.4 用例

`packages/domain/src/use-cases/workspace-groups.ts`：

```ts
prepareWorkspaceGroupUseCase(deps, { projectId, taskId, workerId, home, repoIds?, actor })
retryWorkspaceGroupUseCase(deps, { groupId, actor })
removeWorkspaceGroupUseCase(deps, { groupId, actor })
workspaceGroupsUseCase(deps, projectId)
```

- 准备流程：取项目 repos（`repoIds` 缺省 = 全部，顺序按项目清单，第一个为 primary）→ 每仓找一个 `gitBase`（同 worker 的 isGit 长期空间；没有则 clone，与 `temporary-workspaces.ts:143` 同逻辑）→ `ws.group_init` → 逐个 `ws.add_worktree { repoPath: base.path, path: `${root}/${name}`, branch, existing: true }` → 并行 `ws.run_setup`。
- 失败语义：任一成员建不出来 → 整组 `failed`，已建成的保留；`retry` 只重试 `failed` 成员（建 + 准备）。
- 分支：`agent-hub/<slug>-<4位id>`，slug 由任务标题或会话名生成（复用现有 slug 规则）；若某仓已存在同名分支 → 该成员用 `<branch>-<2位随机>` 并把新名字记进成员背景（极端情况）。
- `remove`：先对所有成员跑现有 `unsavedReason`；任一脏 → 整组 `kept` 返回 `conflict('api 还有未提交的改动')`；全干净 → 逐个 `removeWorkspaceUseCase`，最后 `ws.group_remove`，删组行。
- `workspaceId` 与组的双向：准备完成后写 `Session.workspaceId` 只在 derive 时做（`workspaceId = primary.workspaceId`）。

### 11.5 HTTP / 契约

- `packages/contract/src/wire/entities.ts`：`projectSchema.repos`、`workspaceGroupSchema`；`packages/contract/src/wire/http.ts`：`createWorkspaceGroupRequest { taskId, workerId, repoIds? }`、`deriveSessionRequest.groupId?`。
- 路由：
  - `GET /api/projects/:id/workspace-groups`
  - `POST /api/projects/:id/workspace-groups` → 201 + 组（`state` 先 `preparing`，同步准备完再返回 `ready/failed`）
  - `POST /api/workspace-groups/:id/retry`
  - `DELETE /api/workspace-groups/:id`
  - `GET /api/sessions/:id/workspaces/changes` → `{ members: [{ workspaceId, name, changes: ChangeDto[], summary: {files, insertions, deletions} }] }`
- derive：`groupId` 存在时校验组属于同项目、`state === 'ready'`、worker 一致；`workspaceRoot = group.root`，`workspaceId = primary.workspaceId`。
- 文件 / git / diff / checkpoint 接口统一加可选 `workspaceId`，缺省 primary；服务端校验它属于该会话的组。
- 审计：`workspace.group.create|retry|remove`。

### 11.6 前端

- 项目设置「仓库」区块：`apps/web/src/surfaces/workbench/project-repos.tsx` + DOM-free `project-repos.ts`，testid `project-repos` / `project-repo-add|row|name|url|branch|remove|error|save`。
- 派生对话框：`workspace-chooser` 增 `{ type: 'new_group' }`（仅 `project.repos.length > 1`），展开列出成员与分支，`repoIds` 可逐项取消；选中后 `dialogs.tsx` 先 `POST …/workspace-groups` 再 derive（组失败时就地显示失败成员与重试，不关对话框）。
- 改动页：`apps/web/src/shell/query-keys.ts` 加 `changesAll(sessionId)`；`focus.tsx` 的 `ChangesPane` 有组时走聚合接口按成员分组渲染。
- 提交：`git-dialog.tsx` 顶部成员切换（`git-workspace-switch`），切成员时 key 变化重查。
- 文件页：`files-browser.tsx` 根显示成员列表；进入某成员后走现有逻辑（`workspaceId` 参数）。
- 会话页一行「组合 · N 个仓库」：`worktree-status.tsx` 旁边。

### 11.7 迁移与兼容

- 无数据迁移：`projects.repos` 空 + 旧列有值 → 读时派生一个成员；写入时双写。
- `Session.groupId` 为空 = 今天的行为，全部旧接口不变。
- 组合功能对单仓库项目不可见（`repos.length <= 1` 时 UI 与逻辑都走老路）。
- `PROTOCOL_VERSION` 不变：新增 RPC 属于向后兼容的方法表；老 worker 收到未知方法返回 unsupported，组创建失败并在组上写明「目标机器 Worker 需要升级」。

### 11.8 测试

- domain：`project-repos.test.ts`（校验/上限/重名）、`workspace-group.test.ts`（primary、memberRoot）、`workspace-groups.test.ts`（准备顺序、失败保留、重试只重试失败成员、remove 脏则整组 kept）、`locations.test.ts`（组 → 容器根；无组 → 老路径）。
- storage：`workspace-groups.test.ts` 往返、projects repos 双写与旧列回填。
- server：路由 201/preparing→ready、derive 组未 ready 400、`workspaceId` 越权 403。
- e2e `multi-repo.spec.ts`：两个本地 bare 仓库 → 绑进项目 → 派生 → agent 在两个子目录各改一行 → 改动页两组 → 分别提交 → 删组（脏时被拒）。用 `git init --bare` + `commit --allow-empty` 造基座（worktree 需要 `main` ref）。

### 11.9 任务拆分

| 任务 | 内容 | 依赖 |
| --- | --- | --- |
| T1 | `Project.repos` + 存储列 + 兼容派生 + 项目设置 API/UI | — |
| T2 | `WorkspaceGroup` 领域 + 存储 + `locationsOf` | T1 |
| T3 | worker `ws.group_init/remove` + 节点侧实现 + 契约 | — |
| T4 | 准备 / 重试 / 删除用例 + HTTP + 审计 | T2,T3 |
| T5 | derive 接 `groupId`、启动背景注入、终端 cwd | T4 |
| T6 | 按成员的 git/文件/checkpoint/rewind | T2 |
| T7 | 前端：派生对话框组选项、改动分组、提交切换、文件根 | T4,T5 |
| T8 | e2e + 文档 | 全部 |
