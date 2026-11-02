# ADR 0027：git 工作流（每轮 checkpoint、提交/推送/PR、回滚到消息、清理增强、worktree 改进）

- 状态：accepted（2026-11-02 David 定了 D1–D10，见末尾「定稿」）
- 相关：ADR 0004（按会话串行事件）、ADR 0006（提示词是 journal 事件）、ADR 0011/0017（RBAC）、ADR 0012（fork）、ADR 0013（hub 模型提供商）、ADR 0024（提炼模型选择）、ADR 0025（工作空间文件/改动页）、ADR 0026（团队工作空间、git 配方在工作空间上）、docs/design/workspaces.md §3/§5
- 参考：[pingdotgg/t3code](https://github.com/pingdotgg/t3code)（MIT，Copyright 2026 T3 Tools Inc.，调研版本 `ac8dce0c`）。下文标【t3】的是借鉴其思路；本 ADR 不直接复制其代码，若实现时移植代码片段，须在文件头保留其 MIT 版权声明并在 `THIRD_PARTY_NOTICES` 登记。

## 背景

临时工作空间（git worktree，分支 `agent-hub/<slug>-<id>`）现在「只进不出」：agent 改完只能人工去机器上提交，否则巡检把它标成 `kept`，越积越多。改动页（ADR 0025）只能对比「会话开始时的 HEAD」，看不出某一轮改了什么，也没法撤回某一轮。worktree 创建没有进度、可能被 RPC 超时打断。

## 决定（五块，共用同一套 Worker RPC 与端口）

### 1. 每轮 checkpoint + 改动页「本轮 / 整个会话」

- **何时**：每轮（一次 prompt → agent 结束）开始前记 baseline、结束后记 checkpoint。由 hub 的 `runTurn` 用例在发 prompt 前、收到结束事件后调 Worker `git.checkpoint`。非 git 工作空间跳过（改动页维持现状）。
- **怎么存**【t3】：Worker 用临时 `GIT_INDEX_FILE`：`read-tree HEAD` → `add -A`（遵守 .gitignore）→ `write-tree` → `commit-tree -p <上一个checkpoint或HEAD>` → `update-ref refs/agent-hub/checkpoints/<sessionId>/<序号>`。**不动用户的 index、暂存区、分支、stash**。
- **记录**：表 `turn_checkpoints(session_id, turn_seq, prompt_event_id, baseline_sha, checkpoint_sha, files_changed, insertions, deletions, created_at)`；diff 统计在 Worker 端用 `diff-tree --numstat` 算（同时修掉新文件 `+0` 类问题）。
- **改动页**：顶部分段按钮「本轮 / 整个会话 / 对比 HEAD」，本轮可左右切换第几轮；默认「整个会话」（= 第一个 baseline → 当前工作区）。每轮消息下方显示「改了 N 个文件 +a −b」，点击跳到该轮 diff。
- **共享工作空间**（ADR 0026）：checkpoint 是整个目录的快照，并发会话时本轮 diff 可能混入别人的改动，界面加提示「这段时间还有其他会话在该目录运行」。
- **保留**：见 D1。会话删除/工作空间移除时删对应 ref；`git gc` 前 ref 保证对象不丢。

### 2. 一键提交 / 推送 / 建 PR

- **入口**：会话头部和任务卡片的「Git」菜单：`提交…`、`提交并推送`、`提交、推送并建 PR`、`推送`、`打开 PR`。【t3 的 stacked action】
- **流程**：Worker `git.status` → hub 取 `git.diff`（截断到 64 KB）+ 本任务工作日志 → 用 D4 选定的模型生成 commit message / PR 标题 / 描述（描述包含「做了什么、跑过的检查」）→ 弹窗可编辑 → Worker `git.commit`（只 `add -A` 工作区，作者用操作人的 git 身份，见 D5）→ `git.push`（`-u origin <branch>`）→ 建 PR（D3）→ PR 链接写到任务上。
- **数据**：表 `task_pull_requests(task_id, workspace_id, provider, repo, number, url, branch, base, state, head_sha, merged_at, last_synced_at)`；hub 每 10 分钟（及打开任务时）同步一次状态，供清理规则用。
- **base 分支**：工作空间 git 配方的默认分支（ADR 0026，项目值仅作默认）。
- **长期工作空间**也能用提交/推送，但「建 PR」要求当前不在默认分支上，否则先提示「新建分支」。
- **没有远端**：只开放「提交」，并提示「改动只在这台机器上」。

### 3. 清理规则增强（修订 workspaces.md §5，只针对临时工作空间）

- 新条件（可组合，按项目设置，团队给默认）：
  - **PR 已合并**：`task_pull_requests.state = merged`；squash/rebase 合并时以「工作区 HEAD == PR 最后一个 head_sha」判定为已合并【t3】。
  - **闲置 N 天**：最近会话结束超过 N 天（默认 14）且任务未运行。
  - 原有「任务 done/abandoned 且干净」保留。
- **未提交改动保护**：`ws.status` 一律带 `-c status.showUntrackedFiles=normal`【t3】，`ws.remove` 前 Worker 再查一次（现有）。保护档位见 D7，默认「未提交改动（含未跟踪文件）」。
- **只删 checkout，保留分支、checkpoint ref 和会话历史**；任务再次开始时按分支自动重建 worktree（设计已有，补实现与测试）。
- **清理报告**：每次巡检/「立即清理」写 `workspace_sweep_runs` + `workspace_sweep_items(workspace_id, action: removed|kept|failed, reason, size_bytes)`；项目设置 → 工作空间 → 「清理记录」展示，并列出 worktree 目录中没有记录对应的孤儿目录及大小（只提示，不删）。
- 共享（被多个任务/项目引用）或有运行中会话的一律不删（现有）。

### 4. 回滚到某条消息

- **入口**：每条用户消息的「⋯ → 从这里重来」。对话框两个选项：
  - **只回滚对话**（所有工作空间可用）：把该消息及之后标记为 `rewound`（journal 追加 `session.rewound{fromEventId}` 事件，不物理删，ADR 0006 兼容），提示词回填到输入框；agent 侧：支持 rewind 的 runtime 调原生接口，不支持的按 ADR 0012 从该点 fork 出新会话（D8）。
  - **连文件一起回滚**：Worker `git.restore_checkpoint`，把工作区恢复到该轮 baseline（`read-tree -u --reset <tree>` + 清理该轮新增的未跟踪文件），恢复前先自动再记一个 checkpoint（可撤销）。
- **限制**：文件回滚只对**临时工作空间**开放；以下情况拒绝并说明原因：工作空间被其他任务/项目关联（ADR 0026 共享）、同目录（含父/子目录）有其他运行中会话、该轮之后已有提交被推送。
- **权限**：只回滚对话 = 能在会话里发消息的人；连文件 = 同时有项目 `task.run` 且是会话发起人或项目 owner（D9）。

### 5. worktree 小改进

- **进度、无硬超时**【t3】：`ws.add_worktree` / `ws.clone` 改成长任务：Worker 设 `GIT_PROGRESS_DELAY=0`，解析 stderr 进度行，经现有事件通道推 `workspace.progress{phase, percent}`；RPC 立即返回 `jobId`，不再受 10 秒 RPC 超时限制；可取消。
- **项目 setup script**：工作空间 git 配方加 `setupScript`（如复制 `.env`、`pnpm i`），worktree 建好后在 Worker 执行，输出进进度面板，失败标 `failed` 可重试。
- **submodule 可选**：配方加 `submodules: off | recursive`，默认 `off`。
- **语义化分支名**：先用临时名 `agent-hub/<slug>-<id>`；第一轮结束后用 D4 模型按 diff 生成 `feat/…` / `fix/…` 并 `git branch -m`（尚未推送才改；失败保留临时名）。前缀项目可配（默认 `agent-hub/`）。
- **位置可配**：见 D10。Worker 配置 `worktreesDir`；老记录是绝对路径，不迁移。
- **长名哈希**：目录名 = 分支名 `/`→`-`，超过 40 字符取前 23 字符 + `-` + sha256 前 16 位【t3】。

## 六边形落点

- **domain**：新值对象 `Checkpoint`、`PullRequestLink`、`SweepResult`；`Workspace` 加 `setupScript / submodules`（经 git 配方）。
- **端口**：
  - `WorkspaceHost` 新增：`checkpoint`、`restoreCheckpoint`、`diffRange`、`commit`、`push`、`renameBranch`、`addWorktree`（改为 job）、`jobStatus/cancel`。
  - 新 `PullRequestProvider`（`create / get / list`），首个实现见 D3；`CommitMessageWriter`（调 ADR 0013 模型，失败退回规则版模板）。
  - `CheckpointRepository`、`PullRequestRepository`、`SweepRunRepository`。
- **用例**：`captureTurnCheckpoint`、`getTurnDiff`、`commitAndPush`、`openPullRequest`、`syncPullRequests`、`rewindSession`、`sweepTemporaryWorkspaces`（改）、`prepareWorkspace`（改：进度/setup/改名）。
- **contract**：`worker-methods.ts` 新增 `git.checkpoint / git.restore_checkpoint / git.diff_range / git.commit / git.push / git.rename_branch / ws.job_status / ws.job_cancel`；Worker 版本协商：老 Worker 不支持时界面隐藏对应按钮并提示更新。

## 权限（沿用 ADR 0011/0017，新增权限点）

| 动作 | 需要 |
|---|---|
| 看本轮/会话 diff | 现有 `workspace.files.read` |
| 提交 | 项目 `task.run` + 能用该工作空间（ADR 0026） |
| 推送 / 建 PR | 新增 `git.push`（默认 owner、member 有，D5） |
| 回滚对话 | 能在该会话发消息 |
| 回滚文件 | `task.run` + 会话发起人或项目 owner |
| 改清理规则 / 立即清理 | 项目 owner；团队默认 = 团队 owner |
| 改 setup script / 分支前缀 | 项目 owner（setup script 会在 Worker 上执行，等同执行权限，审计 `workspace.setup_script`） |

所有推送/PR/回滚文件/清理写审计。

## 迁移

- 新表：`turn_checkpoints`、`task_pull_requests`、`workspace_sweep_runs`、`workspace_sweep_items`；`workspaces` 加 `setup_script`、`submodules`、`branch_prefix`（或放 git 配方 JSON）。全部是加表/加列，回滚到旧版本无影响（旧代码忽略新表）。
- 老会话没有 checkpoint：改动页「本轮」置灰，「整个会话」退回 ADR 0025 的「会话开始时的 HEAD」。
- Worker 需要升级才有新 RPC；hub 按版本降级。

## 分阶段实施

1. **P1 checkpoint + 本轮 diff**（约 3–4 天）：Worker RPC、表、`runTurn` 挂钩、改动页切换。是回滚的前提。
2. **P2 提交/推送/PR**（约 3–5 天）：`PullRequestProvider`（D3）、`CommitMessageWriter`、Git 菜单、PR 状态同步。
3. **P3 清理增强**（约 2 天）：依赖 P2 的 PR 状态；报告页、自动重建测试。
4. **P4 回滚到消息**（约 3 天）：依赖 P1。
5. **P5 worktree 改进**（约 2–3 天）：长任务 RPC + 进度、setup script、submodule、改名、位置、哈希名。可与 P3/P4 并行。

每阶段单独 PR，先本地全量测试，上线前数据库快照，上线后用 e2e 测试账号在线上跑一遍。

## 待拍板（每题第一个是推荐）

- **D1 checkpoint ref 与保留**：`refs/agent-hub/checkpoints/<sessionId>/<n>`，会话结束后保留 30 天、工作空间移除时删除 ／ 永久保留 ／ 只保留最近 50 轮。
- **D2 checkpoint 粒度**：每轮前后各一次 ／ 只在轮后（省一半，但第一轮没 baseline 要额外补）。
- **D3 建 PR 方式**：Worker 上的 `gh` CLI（用 Worker 机器已有登录，hub 不存凭据）／ hub 存 GitHub token（团队级密钥，同 ADR 0013 的密钥库，密钥不出 hub，hub 调 GitHub API）／ 两者都支持、优先 hub token。
- **D4 写提交说明/PR/分支名的模型**：复用项目在 ADR 0024 选的提炼模型，没选就用规则版模板 ／ 单独一个「git 文案模型」设置 ／ 用当前会话的 agent 自己生成。
- **D5 谁能推送/建 PR**：项目 owner + member（新增 `git.push`，可在团队里收回）／ 只有 owner ／ 能开会话的都能。提交作者：用操作人 hub 账号的姓名邮箱写 `--author`（committer 仍是 Worker 的 git 身份）／ 一律用 Worker 的 git 身份。
- **D6 清理默认**：新团队默认开启「PR 已合并」和「任务结束且干净」，「闲置 N 天」默认关 ／ 全部默认开（N=14）／ 全部默认关（t3 的做法）。
- **D7 未提交改动保护档位**：保护已跟踪改动 + 未跟踪文件（被忽略的如 `.env`、构建产物可删）／ 任何本地文件（`node_modules` 除外）／ 只保护已跟踪改动。
- **D8 不支持原生 rewind 的 runtime**：从该消息之前 fork 出新会话（ADR 0012，带工作日志）／ 不提供「只回滚对话」。
- **D9 回滚文件范围**：仅临时工作空间，共享/并发时拒绝 ／ 长期工作空间也允许（需二次确认）。
- **D10 worktree 默认位置**：保持仓库旁 `.worktrees/`（新增 Worker 配置可改）／ 改为 Worker 数据目录 `<roots[0]>/agent-hub-worktrees/<repo>/<branch>`（只影响新建）。

## 定稿（2026-11-02 David）

- D1：`refs/agent-hub/checkpoints/<sessionId>/<n>`；会话结束后保留 30 天（每小时巡检删过期 ref 和记录），工作空间移除时一并删除。
- D2：每轮前后各一次。
- D3：**两者都支持**：Worker 上已登录的 `gh` CLI，以及 hub 团队级 GitHub token。token 作为 hub 密钥存放：团队设置 →「代码托管」里由团队 owner 配置，和现有模型提供商密钥同样**加密落盘**（复用 ADR 0013 的密钥加密），接口只回「已配置 / 末 4 位」，永不回显、不写日志、不下发给 Worker；hub 用它直调 GitHub REST API 建 PR。选择顺序：团队配了 token → 用 token；否则 → Worker 的 `gh`；都没有 → 只推送，给出「在 GitHub 上新建 PR」链接。
- D4：项目提炼模型（ADR 0024），没选或调用失败退回规则版模板。
- D5：项目 owner + member 有 `git.push`（推送、建 PR），团队可收回；提交用操作人 hub 账号的姓名/邮箱作 `--author`。
- D6：「PR 已合并」「任务结束且干净」默认开；「闲置 N 天」默认关。
- D7：保护已跟踪改动 + 未跟踪文件（被忽略的文件可删）。
- D8：runtime 不支持原生 rewind 时，从该消息之前 fork 新会话（ADR 0012）。
- D9：文件回滚只限临时工作空间。
- D10：默认保持仓库旁 `.worktrees/`，Worker 配置 `worktreesDir` 可改。
