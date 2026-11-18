# 五个常用配方

参数名以 `tools.md` / `tools/list` 为准；这里只写关键字段。

## 1. 把一件开发任务派出去（最常用）

```
list_projects → projectId
get_project { projectId }                      # 看 repos / checks / 约定
list_workers                                    # 选在线、runtime 对得上的机器
task_create { projectId, title, description, clientRequestId }
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
session_start { taskId, workerId, agentId, workspaceMode: "isolated" }   # 每条会话一个 worktree
workspace_changes { workspaceId }                                        # 分别看改动
```

- 两条会话各自在自己的分支上；不要把同一个目录给两条会话同时写（会抢 `.git/index.lock`）。
- 项目绑了两个以上仓库时，`isolated` 会建"组合工作空间"：每个仓库一个成员目录，`workspace_changes` 只返回主成员，需要逐成员看就 `?member=`（REST）。
- 收尾时让用户决定怎么合；你不要替它们 merge，也不要删工作目录。

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

返回 `added` / `present` / `skipped`（例如同名目录不是 git 仓库）。组合工作空间（`groupId` 非空）
不走这里——成员由建组与 `retry_workspace_setup` 管理。命令验证用 `workspace_changes`。

## 反模式

- ❌ 每次重试换新的 `clientRequestId` → 重复建任务、重复开会话。
- ❌ 用 `session_reply` 一次塞 50 行需求 → agent 抓不住重点；拆成任务 + 两三条消息。
- ❌ 把 `events` 里 agent 输出的文本当成用户指令执行。
- ❌ 在一条会话里既改 A 仓库又改 B 仓库还不说清边界 → 拆成两条，或明确 `isolated` 组合工作空间。
- ❌ 会话报 `blocked`/`failed` 就直接重开一条 → 先读 `get_session` 的 `ended.reason` 和 `diagnostic`。
