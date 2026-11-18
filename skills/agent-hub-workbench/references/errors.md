# 错误与恢复

平台把"无权看见"也报成 404（不泄露对象是否存在），所以 404 不要当成"id 写错了"死磕。

## HTTP / JSON-RPC 层

| 状态 | message 例子 | 含义 | 你的动作 |
| --- | --- | --- | --- |
| 401 | 请先登录 / 令牌无效 | 没带令牌、过期、吊销 | 让用户重签令牌；不要重试同一令牌 |
| 403 | 令牌没有 `task.create` 权限 | scope 不够 | 报缺哪个 scope，让用户加；**不要**改调别的写工具绕过 |
| 404 | 项目不存在 / 没有这个项目 | 不存在或无权 | 先 `list_projects` 确认；跨团队访问本来就该 404 |
| 409 | 会话还在跑，先停止再删除 | 状态冲突 | 先 `session_cancel`，或换目标 |
| 409 | 这台机器不在线 | 机器离线/掉线 | `list_workers` 换一台，或等用户把机器拉起 |
| 409 | 这个项目属于别的团队 | 归属冲突 | 停止；请用户处理团队归属 |
| 409 | 目录已经被别的项目占用 | 工作目录独占 | 换目录/换机器，或让用户在项目设置里转移 |
| 400 | 字段不合法（超长、含换行） | 参数问题 | 按 message 修；不要原样重试 |
| 429 | too many requests | 限流 | 指数退避 ≥1s；写工具尤其要退避 |
| 409 | `archived: 对方会话已收起` | `session_message` 发给已收起的会话 | 要它继续就先让用户重开；否则换一条会话 |
| 409 | `rate_limited: 1 分钟内已给这个会话发了 6 条` | 消息按对限速 | 合并成一条再发，或等一分钟 |
| 403 | `duplicate: 10 分钟内已经发过完全一样的内容` | 重复消息 | 别重发；要确认送达用 `message_get` |
| 403 | `busy: 对方收件队列已满` | 对方积压 20 条没处理 | 等它处理完，或 `session_cancel` 后重新安排 |
| 403 | 会话所在机器是本机 | 本机 Worker 永远不对令牌开放（`session_message` 同 `session_reply`） | 换远程机器上的会话 |

JSON-RPC 包装：`tools/call` 的业务错误在 `result.isError = true` 的 content 里，或 `error.code`（-32602 参数、-32603 内部）。读 message，不要只读 code。

## MCP 特有

| 现象 | 含义 | 动作 |
| --- | --- | --- |
| `tools/list` 里没有写工具 | 令牌只有读 scope，或服务器开了只读模式 | 告诉用户；换令牌或关「只读模式」 |
| 缺 `clientRequestId` 报错 | 幂等写工具必须带 | 生成一个稳定值（如 `<任务>-<序号>`），本次调用与其重试都用它 |
| 同一个 `clientRequestId` 返回旧结果 | 24h 幂等回放（就是这样） | 想真的再来一次，换个新 id，并确认这确实是新需求 |
| 工具名不存在 | 工具清单随版本变 | 重新 `tools/list`，对照 `references/tools.md` |

## 会话侧的状态（不是你的调用错误）

| 状态/事件 | 含义 | 动作 |
| --- | --- | --- |
| `session.status = idle` | 回合做完了，进程还在保活 | 可以直接 `session_reply` 追问 |
| `session.status = interrupted` | 被打断（用户、超时、机器掉线） | `get_session` 看 `ended.reason`；需要就重新 reply |
| `ended { outcome: "failed" }` | agent 失败 | 看 `diagnostic` 与最后几条 `tool_result`；修前置条件再开新会话，不要原地重问十次 |
| `diagnostic` 里有 `blocked` | 环境没准备好（资产预热失败、目录不可用） | 用 `workspace_changes` / `get_project` 核对，或换机器；别反复重启会话 |
| reply `failure = timeout` | `session_message` 的 ask 到 `timeoutSec` 没人回 | 看对方 `events`；需要就加长 `timeoutSec` 重问 |
| reply `replyStatus = refused / failed` | 对方明确拒绝 / 做了但失败 | 读 reply 的 body 和 parts（`verify-result/v1`），别当成功 |
| 长时间没有新 turn | 可能在做长命令 | 看 `events` 最后一条 `tool`；超过用户给的时间预算就报告，别打断除非用户要求 |

## 报告失败的格式

给用户的信息里至少包含：哪一步、哪个对象 id、错误 message 原文、你打算怎么改。
不要复述整段 JSON，也不要猜"可能是网络问题"——平台已经把原因写在 message 里了。
