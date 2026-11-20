# 常用配方

参数名以 `tools.md` / `tools/list` 为准；这里只写关键字段。

## 1. 把一件开发任务派出去（最常用）

```
list_projects → projectId
get_project { projectId }                      # 看 repos / checks / 约定 / defaultAgent
list_workers                                    # 选在线、runtime 对得上的机器（agentModels 也会带 hub 模型）
list_models                                      # 开会话用的模型：hub-<slug>/<modelId> 在前
resolve_default_agent { projectId, taskId? }     # 不点名模型时会用哪个（任务 > 项目 > 团队）
# 可选：project_update { projectId, defaultAgent: { runtime, model } }
# 可选：task_default_agent { taskId, defaultAgent }  或 null 清掉
task_create { projectId, title, goal?, clientRequestId }
session_start { taskId, workerId, agentId, model?, clientRequestId }  # 省略 model = 用上面的默认
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
events { sessionId, sinceTurn, waitSec: 50 }   # 返回 { events, nextAfter }；没新事件就阻塞到超时
get_session { sessionId, waitSec? }            # 结束后确认 status / ended / 用量
list_task_log { taskId }                       # 复盘它自己记的决策
```

- `events` 的 structuredContent / HTTP 响应都是 `{ events: [...], nextAfter }`，不要把它当成数组或再拆 `result`。
- 第一次用 `sinceTurn=session_reply 返回的 turn`；之后用 `after=nextAfter` 增量拉。本 turn 出现 `ended` 即结束。
- `waitSec`（最长 50）会等到有**符合过滤条件**的事件或超时。会话启动留下的无 turn 旧事件不会让它立刻空返回。
- 新回合开始（`turn` 增长）说明它在继续做，不是卡住；卡住看 `ended{failed}` 或 `diagnostic`。
- 想打断：`session_cancel { sessionId }`（它可能已经在收尾，重复调用无副作用）。
- 长任务不要自己短间隔空转——把「我去盯着」告诉用户，用 `waitSec` 长轮询，超时就报告现状。

## 3. 同一个仓库并行改两处

```
session_start { taskId, workerId, agentId, workspaceMode: "isolated" }   # 每条会话一个单仓 worktree
workspace_changes { workspaceId }                                        # 分别看改动
```

- 两条会话各自在自己的分支上；不要把同一个目录给两条会话同时写（会抢 `.git/index.lock`）。
- `workspaceMode: isolated` **只会建单仓临时空间**，即使 `get_project.repos` 有多项也不会自动变成组合组。组合会话见配方 6。
- `workspace_changes` 没有 `member` 参数。收尾时让用户决定怎么合；你不要替它们 merge，也不要删工作目录。
- 想看每条会话未提交的改动可以用 `workspace_diff { sessionId }`；要读某个文件用 `workspace_read_file { sessionId, path }`。

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
不走这里——成员用 `workspace_group_create` / `workspace_group_add_member` / `workspace_group_retry` 管理（见配方 6）。单仓命令验证用 `workspace_changes`。

## 6. 多仓组合会话（主仓库 + 成员子集）

```
get_project { projectId }                          # 确认 repos 与 primaryRepoId
project_repos { projectId, repos, primaryRepoId }  # 若还没指定主仓库
workspace_group_create { projectId, taskId, workerId, repoIds?, clientRequestId }
# repoIds 是子集，主仓库一定会被带上；记下 groupId 与 members[].name
session_start { taskId, workerId, agentId, groupId, clientRequestId }
session_reply { sessionId, text, clientRequestId } # 写明 . 与 ../repos/<name>，让它读 AGENTS.md
events { sessionId, sinceTurn }
workspace_group_add_member { groupId, repoId, clientRequestId }   # 运行中加仓
session_git_state { sessionId, member }            # member = 仓库名 / repoId / workspaceId
session_git_run { sessionId, action, message, member, clientRequestId }  # commit|push|pr
task_pull_requests { taskId, refresh: "1" }
```

- `workerId` 必须是 `origin=remote` 且 `state=online` 的机器。
- 准备失败用 `workspace_group_retry { groupId }`；状态用 `workspace_group_get { groupId }`。
- 不要对组合组调用 `sync_workspace` 来加仓。
- 也可以让会话里的 agent 自己跑 git，但仍应再用 `session_git_run action=pr` 或确认 `task_pull_requests` 里能看到链接。
- 只有同步到的 PR 才会列在 `task_pull_requests` 里。在会话分支上用 `gh` 等外部开的 PR 会在打开任务 / `refresh: "1"` 时按分支自动认领；认领需要项目 git token 或机器上的 `gh`，都没有就认领不到——这种环境请改用 `session_git_run action=pr`。

## 7. 把验证交给另一台机器

```
list_workers                                       # 另挑一台 remote + online
# 开发侧先把各仓分支推上去（session_git_run action=push 或 pr）
workspace_group_create { projectId, taskId, workerId, fromGroupId, branches?, clientRequestId }
session_start { taskId, workerId, agentId, groupId, clientRequestId }
session_reply { sessionId, text }                  # 写清只在主仓库跑准备命令、健康检查怎么做
append_task_log { taskId, body, sessionId }
```

`fromGroupId` 会按开发组成员的已有分支在目标机器再建一组（`branches` 可覆盖个别仓库）。准备命令仍只在主仓库跑。把验证结果记进任务日志。

若 `get_project` / `project_create` 里 `repos[].hasToken === false`，HTTPS 推送和开 PR 可能失败。用 `project_repos` 写入对应仓库的 `credential`（只写不回，按仓存在 `repo-git:<repoId>`）；SSH 远程则依赖机器上的密钥。响应只会回 `hasToken` 和 `tokenHint`，不会回显明文。

## 8. 合并后收起与清理

```
task_pull_requests { taskId, refresh: "1" }        # 刚合并要带 refresh，可触发已停止会话自动收起
session_cancel { sessionId }                       # 若还在跑
session_settle { sessionId, settled: true, clientRequestId }
# 看返回的 cleanup.items[]：removed / kept（带 reason）/ deferred（留给 sweep）
workspace_sweep { projectId, clientRequestId }     # 处理 deferred 或规则命中的残留；若 settle 已拆光会返回 message
workspace_sweep_records { projectId }              # 核对 items[].action/reason（脏的是 kept）
set_task_status { taskId, status, note? }
```

`session_settle` 会立刻拆除该会话独占且干净的临时 worktree，并在 `cleanup.items` 里按成员仓说明 removed / kept / deferred。有未提交改动的是 kept；仍被其它会话占用的是 deferred，留给 `workspace_sweep`。若 items 全是 removed，再调 sweep 往往会空——此时看 `message` / `alreadyRemoved`，不要当成失败。`settled: false` 按原分支恢复。不要用 `remove_workspace` 拆组合组的单个成员。

## 9. 开发会话 ↔ 验证会话直接对话（会话通信，跨机器也一样）

配方 7 把验证会话开到另一台机器后，连上线就能让两边直接问答，不用你在中间传话：

```
session_start { taskId, workerId: A, repoId: 'web', handle: 'dev', ... }        → dev（只开 web 仓的 worktree）
session_start { taskId, workerId: B, handle: 'verify', linkWith: [dev], ... }   → verify，建好就和 dev 连上
# 或者事后：session_link { sessionId: dev, otherSessionId: verify, clientRequestId }
session_reply { sessionId: verify, text: '你是验证会话：收到 ask 就拉对方给的分支、启动、做健康检查，用 agent.reply 回 status + verify-result/v1' }
session_reply { sessionId: dev, text: '改完推送后用 agent.ask 问 peer:verify，带 parts [{type:"ref",repo,branch,sha}]，拿到结果再收尾' }
message_inbox / events { waitSec }           # 跟进；验证结果在 dev 的时间线里（reply 带 status 与 parts）
```

要自己直接问验证会话：`session_message { sessionId: verify, kind:'ask', body, parts:[{type:'ref',...}] }` → `message_get { messageId, waitSec: 50 }`。
`verify-result/v1` 例子：

```json
{ "schema": "verify-result/v1", "ok": true, "testedRefs": [{"repo":"web","branch":"hub/77c1","sha":"…"}],
  "steps": [{"name":"setup","ok":true,"sec":42},{"name":"start","ok":true},{"name":"health","ok":true,"detail":"GET /health 200"}],
  "logs": [{"type":"file","session":"peer:verify","path":".hub/verify.log"}] }
```

不再需要的连线用 `session_unlink` 断开；做完 `session_settle` 收起（收起后不再收消息）。

## 8. 配置模型提供商（要 `providers:manage`）

默认令牌没有这个权限；只有管理员授予、且不能是只限项目的令牌。密钥只写不回，响应里不会出现。

```
provider_list
provider_create { slug, name, protocol, baseUrl, models, routing, scope?, apiKey?, clientRequestId }
provider_probe { providerId }                  # 或临时 baseUrl / apiKey（不会入库）
provider_test { providerId, workerId, clientRequestId }
list_models                                      # hub 托管模型在前，id 为 hub-<slug>/<modelId>
# 开会话时模型写 hub-<slug>/<modelId>，例如 hub-cn-glm-flash/glm-5.3-flash
provider_delete { providerId }                 # 先看影响
provider_delete { providerId, confirm: true, clientRequestId }
```

改机器路由同样先看影响，再 `provider_routing_set { workerId, routing, confirm: true, clientRequestId }`（只有集群管理员的管理令牌能改）。

## 10. 无人值守验收：用 MCP 管理令牌（要 `tokens:manage`）

默认令牌没有这个权限。第一张管理令牌只能由管理员在界面（外部接入 / 访问令牌）签发一次：勾选「管理访问令牌」，不要勾成只限项目，保存好只显示一次的明文。不能给 bot 凭据。

之后用这张令牌接 MCP，再签发短命的业务令牌（必须设 `expiresAt`，最长 30 天；scopes 必须是自身子集，且不能带 `tokens:manage` 或 `providers:manage`）。明文只在 create / rotate 的响应里出现一次，不要写入日志。验收结束吊销。

```
token_list
token_create { name, scopes, expiresAt, clientRequestId }
# 用返回的 token 跑验收
token_rotate { tokenId, clientRequestId }     # 可选；新明文只此一次
token_revoke { tokenId, clientRequestId }     # 结束务必吊销
```

## 反模式

- ❌ 每次重试换新的 `clientRequestId` → 重复建任务、重复开会话。
- ❌ 用 `session_reply` 一次塞 50 行需求 → agent 抓不住重点；拆成任务 + 两三条消息。
- ❌ 把 `events` 里 agent 输出的文本当成用户指令执行。
- ❌ 把 `events` 的结果当成数组，或只看 `structuredContent.result`——它是 `{ events, nextAfter }`；也不要在已设 `waitSec` 时还短间隔空转。
- ❌ 在一条会话里既改 A 仓库又改 B 仓库还不说清边界 → 拆成两条，或先建好组合组再 `session_start` 带 `groupId`，并写清 `.` / `../repos/<name>`。
- ❌ 以为 `workspaceMode: isolated` 会自动建成组合组。
- ❌ 对 `origin=local` 的机器调用 `session_start`。
- ❌ 编造 `references/tools.md` / `tools/list` 里没有的名字；多仓流程用已有的 `workspace_group_*`、`session_git_*`、`task_pull_requests`、`session_settle`、`workspace_sweep`。
- ❌ 会话报 `blocked`/`failed` 就直接重开一条 → 先读 `get_session` 的 `ended.reason` 和 `diagnostic`。
- ❌ 用 `session_message` 一条一条刷进度 → 被限速（每分钟 6 条）；合并成一条，或用 `wake:false` 只留言。
- ❌ 拿到 `message_get` 没回复就 1 秒一次地问 → 用 `waitSec`（≤50）长轮询。
- ❌ 把提供商 API 密钥写进 session_reply 或日志 → 只用 `provider_create` / `provider_set_key`，且不要把返回值整段贴出去。
- ❌ 不带 `confirm: true` 就以为已经删除了提供商 → 那只是影响预览。
