# Worktree 机制设计

目标：把「一个任务在独立 checkout 里干活」做成**平台原生**能力——路径、分支、准备、清理、回收全部由 hub 决定，worker 只执行；agent 不自己 `git worktree add`。

现状（底稿来自盘点）：临时工作空间已经是 worktree，但它是**任务级、隐式**的——建任务时顺手开一个，用户看不见分支、看不到准备过程、清理只看脏不脏；agent 想换目录只能自己在 shell 里干活，然后 diff/终端/清理全看老目录（T3 Code 的 issue #3753 就是同一个坑）。

## 1. 不变量（不许破）

1. **路径和分支名由 domain 算**，worker 只做 `relocateWorktree` 平移；否则不可预测、不可复活。
2. **worktree 只能是临时工作空间**（`kind='temporary'`、`source='worktree'`），必须绑 `task + project`。
3. 所有 IO 走 `WorkspaceGit` 端口；`workerId===null` = Server 本机。
4. 目录必须在 `WORKER_ROOTS` 内（`createDirectory` 的 `insideRoots` + `git-workspace.ts:44` 的 `guard` 双保险）。
5. 删除前 `dropCheckpoints`；脏则 `kept + keptReason`；非 git 目录只有完全空才删；清理 fail-open。
6. `root===''` 一律在调用方拒绝，绝不当 `/`。

## 2. 三个档位（用户能看见的选择）

| 档位 | 目录 | 适用 | 现状 |
| --- | --- | --- | --- |
| 共用长期空间 `shared` | 项目关联的 long_lived 目录 | 单人顺序干活、要看到别人未提交的改动 | 已有（`defaultWorkspaceFor`） |
| 隔离 worktree `isolated` | `.worktrees/<repo>/<slug>-<id>` | 并行任务、后台 agent、要开 PR | 已有创建，但没产品化 |
| 临时目录 `scratch` | `agent-hub-workspaces/.tmp/<slug>-<id>` | 非 git 项目 | 已有 |

新增的是**选择权与可见性**：建任务/开会话时明确选档位，会话页显示「在哪个目录、哪条分支、是否就绪」。

**默认档位（已定）**：所有项目（含新项目）默认 `shared`，隔离只能由人显式选。理由：默认隔离会让「单人流」凭空多一步合并；配套的引导放在选择器里（git 项目在 `isolated` 档显示「并行 / 会开 PR 时选这个」）。

## 3. 项目级 worktree 配置

`Project` 增字段（可空，老数据不用迁移）：

```ts
interface ProjectWorktree {
  /** 新任务默认档位；老项目保持 shared。 */
  readonly mode: 'shared' | 'isolated';
  /** 建好 worktree 后自动跑的准备命令；null = 不跑。 */
  readonly setup: ProjectSetup | null;
}
interface ProjectSetup {
  readonly command: string;        // 例：npm ci && npm run db:migrate
  readonly waitForSetup: boolean;  // true = 阻塞 agent 启动，直到命令退出
  readonly timeoutSeconds: number; // 30..1800，默认 600
}
```

规则：
- 只有**项目 owner / admin** 能改（复用 `project.update`），改完写审计 `project.worktree`。
- `command` 只来自项目配置，**不接受每次运行时由客户端传命令**（这是防止「任意 shell」的关键）。
- 设置页放在项目设置的「工作空间」页，和清理面板并列；文案说明「准备命令在这台机器上、以 worker 用户身份执行」。

## 4. 创建流程（含准备状态机）

```
prepareTemporaryWorkspace
  → 选基座（command.base → project.repo.defaultBranch → 长期空间当前分支）
  → addWorktree（domain 定路径/分支：agent-hub/<slug>-<4>）
  → workspace.setup = {state:'running', startedAt}
  → [setup 命令]（超时 killing 进程组，保留最后 8KB 输出）
      → 成功: {state:'ready', exitCode:0, tail}
      → 失败: {state:'failed', exitCode, tail}  ← 目录保留给人排查，agent 不启动
  → workspace.state 从 preparing → ready
```

- `waitForSetup=false`：命令后台跑，会话可以先开；界面上给「正在准备」提示，准备好前允许聊天但工具调用可能失败——所以默认建议 `true`。
- `waitForSetup=true`：`startSessionUseCase` 在派发前等它完成（有上限，超时按失败处理）。
- `setup` 失败**不自动删目录**：保留 + `keptReason='准备失败'`，让人看一眼、改脚本、点重试。
- 重试：`workspace.setupRetry`（只对 `failed` 生效，重跑同一条命令）。

落点：
- `packages/domain/src/project.ts`（字段 + `worktreeProblem()` 校验）
- `packages/domain/src/workspace.ts`（`setup` 状态）
- `packages/domain/src/ports/workspace-git.ts`（`runSetup({path, command, timeoutMs, env})`）
- `packages/contract/src/worker-methods.ts`（`ws.run_setup`，权限 `git`）
- worker：`packages/node-gateway/src/setup-script.ts`（spawn + 进程组 kill + 输出截断 + env 白名单）
- 用例：`packages/domain/src/use-cases/temporary-workspaces.ts`（接入）、`use-cases/start-session.ts` / `hosting.ts`（等待）

注入环境变量：`AGENT_HUB_PROJECT_ROOT`、`AGENT_HUB_WORKTREE_PATH`、`AGENT_HUB_BRANCH`；**不注入** `HUB_TOKEN` / `HUB_WORKER_CREDENTIAL` / `HUB_LOCAL_SECRET`（沿用终端那套剔除规则）。

## 5. 会话与空间绑定

- 一期：**开场就定**。会话创建时选定档位；`Session.workspaceId` 之后不改。
- 一期就有的两条入口：`POST /api/sessions/derive { workspaceMode }`（人/脚本）与 agent 工具 `agent.spawn { workspace_mode: 'isolated' }`（会话内的 agent 给自己开一个隔离兄弟会话，调度器/bot 触发同样适用）。前端 derive 对话框里勾「隔离 worktree」等价于前者，勾上时不发送 `workspaceId`，以档位为准。
- 二期：`session.handoffWorktree`（会话迁入 worktree）。会话必须空闲（非 running）；建/复用 worktree → 改 `workspaceId` → `startSessionUseCase({markFailed:false})` 重新托管；同时暴露两个 agent 工具：
  - `session.worktree.status` — 我现在在哪个目录/分支、是否已隔离；
  - `session.worktree.handoff({baseRef?, branch?, path?})` — 请 hub 把我迁进 worktree。
  这样 agent 不需要、也不应该自己 `git worktree add`。
- 迁移不改会话历史：journal/artifact 都挂在 session 上，目录只是 `workspaceId` 指向的东西（和 `continue-elsewhere` 同一套动作，只是原地）。

## 6. 生命周期与清理

沿用 ADR 0027，补三条判定：

1. **活动判定**：有 live terminal（`terminal.list` 命中该目录）或在跑的会话 → 不清。
2. **PR 合并**：`prMerged` 已有，默认开；补「合并后把 `state` 标成 `kept`，一周后清理」的可选项（默认关）。
3. **闲置**：`idleDays` 已有（默认关），保持默认关，但界面上给开关。

孤儿目录：现在只认路径含 `/.worktrees/`（`workspace-cleanup-admin.ts:64-66`）。改为**按 worker 的 `worktreesDir` 前缀 + workspace 行**判断：目录在 worktreesDir 下、没有对应 workspace 行、且不脏 → 列进「孤儿目录」，仍然只让人手动删。

`preparing` / `failed` 两个空置状态这次真正用起来（`failed` 只在 setup 失败时写）。

## 7. UI

- **workspace chooser**（`workspace-chooser.tsx`）：机器 + 工作空间一起选；单选里多一项「新建隔离 worktree（新分支）」（`ws-new-worktree`），选中时说明「在 <机器> 上新建分支 agent-hub/…，先跑项目配置的准备命令」。它不遮住机器选择——档位是工作空间的一种，不是对话框上的额外开关。项目默认 isolated 时打开即选中；没有可用 git 基座时这一项置灰并说明原因。
- **会话页**：标题区一行小字「worktree · agent-hub/foo-1a2b · 就绪」；准备中显示进度、失败显示原因 + 「看输出」「重试」「在终端打开」。
- **项目设置 · 工作空间**：默认档位 + 准备命令 + 等待开关 + 超时；旁边是现有清理策略。
- **机器页**：显示该 worker 的 `worktreesDir`（已有日志，提到 UI）。

## 8. 安全

- 命令只来自项目配置，`owner/admin` 可写；每次执行写审计 `workspace.setup`（含 exit code，不写完整输出——输出可能含密钥）。
- 执行身份是 worker 用户；目录必须落在 `WORKER_ROOTS`；超时后杀进程组（`pidtree`，和终端一致）。
- 日志返回前过一遍现有脱敏（`gitMessage` 同类：抹 `user:token@`、截行数）。
- 这条能力等价于「项目管理员可以在机器上跑一条命令」——与今天「能在终端里跑」同一信任级别，但不引入「任何成员随时跑任意命令」的新面。

## 9. 验证

- domain 单测：字段校验、状态机（ready/失败/重试）、等待语义、清理判定。
- worker 单测：临时 repo 上跑 `addWorktree` + setup（成功/失败/超时/输出截断/env 无密钥）。
- e2e：建项目（配 setup 命令 `node -e "..."`）→ 建任务 → 选 isolated → 看到准备中 → 就绪后可聊；失败用例看到原因与重试。
- 整仓：`check` / `typecheck` / `typecheck:web` / `npm test` / `build` / `test:e2e-node` + 一次真机（阿里云 + 本地 worker）。

## 10. 分期

| 期 | 内容 | 量级 |
| --- | --- | --- |
| W1 | `Project.worktree` 字段 + 校验 + 设置页 + 审计 | 0.5 天 |
| W2 | `ws.run_setup` + 执行/超时/截断 + `workspace.setup` 状态 + 创建流程与等待 | 1 天 |
| W3 | 清理活动判定 + 孤儿目录泛化 + 会话页状态行 · **已落地 2026-11-14**（终端算活动、孤儿按登记路径反推父目录） | 0.5 天 |
| W4 | `session.handoffWorktree` + 两个 agent 工具 + 选择器收尾 · **不做**（用户明确不迁已在跑的会话） | 1.5 天 |

## 11. 与 T3 Code 的差异（有意的）

- 我们**默认 shared、显式才隔离**（用户已拍板），T3 让每个 thread 都选。
- 我们不做「随时切换 provider/模型档位」那套；worktree 只解决目录隔离。
- 我们不把 worktree 当安全边界：边界仍是 worker + `WORKER_ROOTS` + 权限判定。

## 12. 待拍板

1. ~~新 git 项目默认 `isolated`？~~ **已定：一律默认 `shared`**，隔离必须显式选。
2. ~~准备命令允许到什么程度~~ **已定：允许项目管理员写任意 shell**——超时上限 30 分钟、不注入密钥、每次执行写审计 `workspace.setup`；与「能在终端里跑命令」同一信任级别，但不新增「任何成员随时跑任意命令」的面。
