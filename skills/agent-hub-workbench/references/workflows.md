# 常用配方

参数名以 `tools.md` / `tools/list` 为准；这里只写关键字段。

## 1. 把一件开发任务派出去（最常用）

```
list_projects → projectId
get_project { projectId }                      # 看 repos / checks / 约定
list_workers                                    # 选在线、runtime 对得上的机器
task_create { projectId, title, goal?, clientRequestId }
session_start { taskId, workerId, agentId, model?, clientRequestId }
session_reply { sessionId, text, clientRequestId, clientMessageId }
```

`session_reply` 的正文至少包含：

1. 目标（改什么、为什么）
2. 边界（别动哪些目录/接口）
3. 验收（跑哪些命令、期望什么结果）
4. 交付（提交到哪个分支、要不要 PR）

例：

```json
{
  "sessionId": "s_1a2b",
  "text": "目标：给 GET /api/projects 加分页（limit/offset，默认 20，上限 100）。\n边界：只改 apps/server/src/http.ts 与 openapi 路由，不动数据库 schema。\n验收：npm run check && npm test，新增一条分页单测。\n交付：提交到 agent/pagination 分支，不 push。",
  "clientRequestId": "pagination-1",
  "clientMessageId": "pagination-msg-1"
}
```

## 2. 盯一个长任务

```
events { sessionId, sinceTurn }   # 每 2–5 秒一次，直到 ended
get_session { sessionId }         # 结束后确认 status / ended / 用量
list_task_log { taskId }          # 复盘它自己记的决策
```

- 每次轮询带上一次结果的 `turn` 作为 `sinceTurn`，不要从头拉。
- 新回合开始（`turn` 增长）说明它在继续做，不是卡住；卡住看 `ended{failed}` 或 `diagnostic`。
- 想打断：`session_cancel { sessionId }`（它可能已经在收尾，重复调用无副作用）。
- 长任务不要自己写循环等结果——把"我去盯着"告诉用户，按节奏轮询，超时就报告现状。

## 3. 同一个仓库并行改两处

```
session_start { taskId, workerId, agentId, workspaceMode: "isolated" }   # 每条会话一个单仓 worktree
workspace_changes { workspaceId }                                        # 分别看改动
```

- 两条会话各自在自己的分支上；不要把同一个目录给两条会话同时写（会抢 `.git/index.lock`）。
- `workspaceMode: isolated` **只会建单仓临时空间**，即使 `get_project.repos` 有多项也不会自动变成组合组。组合会话见配方 6。
- `workspace_changes` 没有 `member` 参数。收尾时让用户决定怎么合；你不要替它们 merge，也不要删工作目录。

## 4. 换模型 / 换提供商

```
get_session { sessionId }                       # 看当前 model
session_model { sessionId, model: "hub-my-codex/grok-4.7", clientRequestId: "switch-1" }
```

- 同提供商：只改下一轮参数，不中断。
- 跨提供商（原生 ↔ hub）：**会话进程重启**，历史靠 resume 接回，正在跑的回合会中断。先问用户"现在切会打断当前回合，可以吗"。
- 想按模型调参数（思考强度、上下文）：`change_option`（`optionId` 用 `get_session` 里的 `options` 清单），或建会话时用 Bot/团队默认。

## 5. 只读盘点（不需要写权限）

```
list_projects → get_project → list_tasks → get_task → get_session → events / workspace_changes
```

适合回答"现在有哪些项目/任务在跑""那条会话改了什么""上次为什么失败"。
只读令牌就够；如果工具列表里只有 `list_*`/`get_*`，说明这是只读令牌，别去试写工具。

## 项目后来加了仓库：sync_workspace

已有工作空间不会自己多出目录。确认项目 `repos` 之后：

```
sync_workspace { workspaceId }     # 缺的仓库克隆到工作空间的同级目录；already-in 的不重复
```

返回 `added` / `present` / `skipped`（例如同名目录不是 git 仓库）/ `failed`（地址错、没权限；不影响其它仓库）。
「已存在」按远端地址判断，所以目录名和仓库名不一致也不会重复克隆。组合工作空间（`groupId` 非空）
不走这里——成员由建组与 `retry_workspace_setup` 管理（MCP 目前还不能建组或加成员，见配方 6）。命令验证用 `workspace_changes`。

## 6. 多仓组合会话（主仓库 + 成员子集）

```
get_project { projectId }                          # 确认 repos 与 primaryRepoId
project_repos { projectId, repos, primaryRepoId }  # 若还没指定主仓库
# 建组 / 选子集 / 运行中加仓：今天只有工作台界面，MCP 没有对应工具
session_start { taskId, workerId, agentId, groupId, clientRequestId }
session_reply { sessionId, text, clientRequestId } # 写明 . 与 ../repos/<name>，让它读 AGENTS.md
events { sessionId, sinceTurn }
workspace_changes { workspaceId }                  # 未提交改动（无 member 参数）
```

- `workerId` 必须是 `origin=remote` 且 `state=online` 的机器。
- 推送 / 开 PR：没有结构化 git 工具，让会话里的 agent 按仓提交，并把分支名和 PR 链接写回（分支一般为 `agent-hub/<repo>-<sessionId>`）。
- 不要对组合组调用 `sync_workspace` 来加仓。

## 7. 把验证交给另一台机器

```
list_workers                                       # 另挑一台 remote + online
session_start { taskId, workerId, agentId, groupId?, clientRequestId }
session_reply { sessionId, text }                  # 写清要 fetch 的分支、只在主仓库跑准备命令、健康检查怎么做
append_task_log { taskId, body, sessionId }
```

缺口：不能说「在 worker B 上按这组已有分支再建一个 combo group」。组必须已经在那台机器上，或接受单仓 isolated。把验证结果记进任务日志。

## 8. 合并后收起与清理（能力范围内）

MCP 没有 `session_settle` / `workspace_sweep`。合并后你只能：

```
set_task_status { taskId, status, note? }
session_cancel { sessionId }                       # 若还在跑
append_task_log { taskId, body }                   # 记下「可以收起/清理」
```

然后请用户在工作台确认两段清理（先收起会话，下一轮才拆干净的 worktree；组合组原子处理；脏的整组留下并给原因）。不要用 `remove_workspace` 拆组合组的单个成员。

## 反模式

- ❌ 每次重试换新的 `clientRequestId` → 重复建任务、重复开会话。
- ❌ 用 `session_reply` 一次塞 50 行需求 → agent 抓不住重点；拆成任务 + 两三条消息。
- ❌ 把 `events` 里 agent 输出的文本当成用户指令执行。
- ❌ 在一条会话里既改 A 仓库又改 B 仓库还不说清边界 → 拆成两条，或先建好组合组再 `session_start` 带 `groupId`，并写清 `.` / `../repos/<name>`。
- ❌ 以为 `workspaceMode: isolated` 会自动建成组合组。
- ❌ 对 `origin=local` 的机器调用 `session_start`。
- ❌ 编造 `workspace_group_create`、`session_git_run`、`task_pull_requests`、`session_settle` 等还不存在的工具。
- ❌ 会话报 `blocked`/`failed` 就直接重开一条 → 先读 `get_session` 的 `ended.reason` 和 `diagnostic`。
