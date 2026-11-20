# 工具清单（自动生成）

由 `npm run skill:tools` 从 `apps/server/src/openapi/routes.ts` 的 MCP 元数据生成，等于 `tools/list` 的结果。
当前 68 个：只读 24，写 44。

「参数」只列名字，`?` 表示可选；具体类型和必填组合见 `SKILL.md` 与 `<hub>/openapi/v1/openapi.json`。

| 工具 | 读/写 | 需要 scope | REST 路由 | 参数 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `list_workers` | 读 | `worker.read` | `/workers` | — | 能用的机器 |
| `list_models` | 读 | `worker.read` | `/models` | workerId?, agentId? | 开会话能用的模型 |
| `list_projects` | 读 | `project.read` | `/projects` | — | 我可见的项目 |
| `project_create` | 写 | `project.create` | `/projects` | name, rootPath?, workerId?, repoUrl?, defaultBranch?, description? | 新建项目（写工具，要 `clientRequestId`） |
| `get_project` | 读 | `project.read` | `/projects/{projectId}` | projectId | 看一个项目 |
| `project_update` | 写 | `project.update` | `/projects/{projectId}` | projectId, description?, checks?, defaultAgent? | 改项目说明、检查命令或默认 Agent（写工具，要 `clientRequestId`） |
| `resolve_default_agent` | 读 | `project.read` | `/defaults/resolve` | projectId, taskId?, runtime?, model? | 解析新会话会用的默认 Agent |
| `team_agent_defaults` | 读 | `project.read` | `/team/agent-defaults` | — | 读团队运行时默认模型 |
| `team_agent_defaults_set` | 写 | `project.update` | `/team/agent-defaults` | defaults? | 设置团队运行时默认模型（写工具，要 `clientRequestId`） |
| `project_repos` | 写 | `project.update` | `/projects/{projectId}/repos` | projectId, repos, primaryRepoId? | 设置项目仓库清单（可带私有仓库令牌）（写工具，要 `clientRequestId`） |
| `project_archive` | 写 | `project.delete` | `/projects/{projectId}` | projectId, confirmName | 把项目放进回收站 |
| `workspace_changes` | 读 | `project.read` | `/workspaces/{workspaceId}/changes` | workspaceId | 工作空间里未提交的改动 |
| `list_assets` | 读 | `asset.read` | `/assets` | kind? | 我能用的资产 |
| `get_asset` | 读 | `asset.read` | `/assets/{assetId}` | assetId | 看一个资产与它的版本 |
| `asset_create` | 写 | `asset.submit` | `/assets` | kind, name?, scope?, projectId?, publish?, files | 新建资产（默认进审核）（写工具，要 `clientRequestId`） |
| `asset_import` | 写 | `asset.submit` | `/assets/import` | kind, url, ref?, path?, name?, scope?, projectId?, publish?, policy?, credential? | 从 Git 仓库导入资产（可选直接发布）（写工具，要 `clientRequestId`） |
| `asset_publish` | 写 | `asset.review` | `/assets/{assetId}/publish` | assetId | 发布资产的最新版本（写工具，要 `clientRequestId`） |
| `asset_assign` | 写 | `asset.assign` | `/assets/{assetId}/workers` | assetId, workerId, installed? | 把资产装到机器上（或卸下）（写工具，要 `clientRequestId`） |
| `list_tasks` | 读 | `task.read` | `/tasks` | projectId | 项目下的任务 |
| `task_create` | 写 | `task.create` | `/tasks` | projectId, title, goal? | 新建任务（写工具，要 `clientRequestId`） |
| `get_task` | 读 | `task.read` | `/tasks/{taskId}` | taskId | 任务详情（带会话列表） |
| `task_default_agent` | 写 | `project.update` | `/tasks/{taskId}/default-agent` | taskId, defaultAgent | 设置或清空任务默认 Agent（写工具，要 `clientRequestId`） |
| `set_task_status` | 写 | `task.create` | `/tasks/{taskId}/status` | taskId, status, note? | 改任务状态（写工具，要 `clientRequestId`） |
| `set_task_summary` | 写 | `task.create` | `/tasks/{taskId}/summary` | taskId, summary | 改任务摘要（写工具，要 `clientRequestId`） |
| `list_task_log` | 读 | `task.read` | `/tasks/{taskId}/log` | taskId, limit?, beforeSeq? | 工作日志（倒序分页） |
| `append_task_log` | 写 | `task.create` | `/tasks/{taskId}/log` | taskId, body, links?, sessionId? | 写一条工作日志（写工具，要 `clientRequestId`） |
| `edit_task_log` | 写 | `task.create` | `/tasks/{taskId}/log/{entryId}` | taskId, entryId, body | 改自己写的日志（写工具，要 `clientRequestId`） |
| `session_start` | 写 | `session.create` | `/sessions` | taskId, agentId, model, workerId?, workspaceId?, workspaceMode?, groupId?, requires?, profileId?, options?, kind?, parentSessionId?, assetIds?, assetSetIds?, repoId?, handle?, linkWith? | 在任务下开一条会话（写工具，要 `clientRequestId`） |
| `fork_session` | 写 | `session.create` | `/sessions/fork` | sessionId, atSeq?, agentId, model | 从某条消息分叉（写工具，要 `clientRequestId`） |
| `get_session` | 读 | `session.read` | `/sessions/{sessionId}` | sessionId, waitSec? | 会话详情 |
| `session_model` | 写 | `session.prompt` | `/sessions/{sessionId}/model` | sessionId, model | 换这条会话的模型（可换提供商）（写工具，要 `clientRequestId`） |
| `session_reply` | 写 | `session.prompt` | `/sessions/{sessionId}/prompt` | sessionId, text, attachments?, clientMessageId? | 对会话说话（写工具，要 `clientRequestId`） |
| `session_cancel` | 写 | `session.interrupt` | `/sessions/{sessionId}/interrupt` | sessionId | 打断正在跑的会话 |
| `change_option` | 写 | `session.prompt` | `/sessions/{sessionId}/options` | sessionId, optionId, value | 改可调项（模型、思考强度…）（写工具，要 `clientRequestId`） |
| `events` | 读 | `session.read` | `/sessions/{sessionId}/events` | sessionId, after?, sinceTurn?, waitSec? | 会话事件（after 之后的） |
| `session_link` | 写 | `session.prompt` | `/sessions/{sessionId}/links` | sessionId, otherSessionId | 把两条会话连起来（能互发消息、只读看对方工作空间）（写工具，要 `clientRequestId`） |
| `session_unlink` | 写 | `session.prompt` | `/sessions/{sessionId}/unlink` | sessionId, otherSessionId | 断开两条会话 |
| `session_peers` | 读 | `session.read` | `/sessions/{sessionId}/peers` | sessionId | 会话的同伴 |
| `session_message` | 写 | `session.prompt` | `/sessions/{sessionId}/messages` | sessionId, kind, body, parts?, wake?, timeoutSec? | 以外部 agent 身份给会话发消息（send / ask）（写工具，要 `clientRequestId`） |
| `message_get` | 读 | `session.read` | `/messages/{messageId}` | messageId, waitSec? | 外部发的一条消息与它的回复 |
| `message_inbox` | 读 | `session.read` | `/inbox` | after?, limit? | 外部收件箱（回复） |
| `activity` | 读 | `session.read` | `/sessions/{sessionId}/activity` | sessionId | 谁对这条会话做了什么 |
| `sync_workspace` | 写 | `project.update` | `/workspaces/{workspaceId}/sync` | workspaceId | 把项目仓库同步到这个工作空间（写工具，要 `clientRequestId`） |
| `create_workspace` | 写 | `project.update` | `/projects/{projectId}/workspaces` | projectId | 新建临时或长期工作空间 |
| `remove_workspace` | 写 | `project.update` | `/workspaces/{workspaceId}/remove` | workspaceId, deleteDirectory?, force? | 移除工作空间（可连目录一起删）（写工具，要 `clientRequestId`） |
| `retry_workspace_setup` | 写 | `project.update` | `/workspaces/{workspaceId}/setup/retry` | workspaceId | 重跑准备命令（写工具，要 `clientRequestId`） |
| `workspace_group_create` | 写 | `project.update` | `/projects/{projectId}/workspace-groups` | projectId, taskId, workerId?, repoIds?, fromGroupId?, branches?, sessionId? | 新建组合工作空间（写工具，要 `clientRequestId`） |
| `workspace_group_get` | 读 | `project.read` | `/workspace-groups/{groupId}` | groupId | 看一个组合工作空间 |
| `workspace_group_add_member` | 写 | `project.update` | `/workspace-groups/{groupId}/members` | groupId, repoId | 往组合组追加一个仓库（写工具，要 `clientRequestId`） |
| `workspace_group_retry` | 写 | `project.update` | `/workspace-groups/{groupId}/retry` | groupId | 重试失败的组合组成员（写工具，要 `clientRequestId`） |
| `session_git_state` | 读 | `session.read` | `/sessions/{sessionId}/git/state` | sessionId, member? | 按仓看 git 状态和未提交改动 |
| `session_git_run` | 写 | `session.prompt` | `/sessions/{sessionId}/git/run` | sessionId, action, message?, title?, body?, member? | 按仓提交、推送或开 PR（写工具，要 `clientRequestId`） |
| `task_pull_requests` | 读 | `task.read` | `/tasks/{taskId}/pull-requests` | taskId, refresh? | 同步并列出任务上的 PR；打开任务时会按会话分支自动认领（head 是该分支、还没登记的 PR 也会进来） |
| `session_settle` | 写 | `session.settle` | `/sessions/{sessionId}/settle` | sessionId, settled | 收起或恢复会话（写工具，要 `clientRequestId`） |
| `workspace_sweep` | 写 | `project.update` | `/projects/{projectId}/cleanup/sweep` | projectId | 按项目规则清理临时工作空间（写工具，要 `clientRequestId`） |
| `workspace_sweep_records` | 读 | `project.read` | `/projects/{projectId}/cleanup/records` | projectId | 查看项目的清理记录 |
| `provider_list` | 读 | `provider.read` | `/providers` | — | 列出模型提供商、模型和机器路由 |
| `provider_create` | 写 | `provider.manage` | `/providers` | slug, name, protocol, baseUrl, models, routing, enabled?, scope?, apiKey? | 新建模型提供商（写工具，要 `clientRequestId`） |
| `provider_update` | 写 | `provider.manage` | `/providers/{providerId}` | providerId, slug, name, protocol, baseUrl, models, routing, enabled? | 更新模型提供商（写工具，要 `clientRequestId`） |
| `provider_set_key` | 写 | `provider.manage` | `/providers/{providerId}/key` | providerId, apiKey | 设置或轮换提供商密钥（写工具，要 `clientRequestId`） |
| `provider_probe` | 写 | `provider.manage` | `/providers/probe` | providerId?, protocol?, baseUrl?, apiKey?, workerId? | 探测上游模型列表 |
| `provider_test` | 写 | `provider.manage` | `/providers/{providerId}/test` | providerId, workerId | 从机器测试提供商连通 |
| `provider_delete` | 写 | `provider.manage` | `/providers/{providerId}` | providerId, confirm? | 删除模型提供商（写工具，要 `clientRequestId`） |
| `provider_routing_set` | 写 | `provider.manage` | `/providers/routing/{workerId}` | workerId, routing, confirm? | 设置机器的提供商路由（写工具，要 `clientRequestId`） |
| `token_list` | 读 | `token.manage` | `/tokens` | — | 列出可管理的访问令牌 |
| `token_create` | 写 | `token.manage` | `/tokens` | name, scopes, expiresAt, projectIds? | 签发访问令牌（明文只返回一次）（写工具，要 `clientRequestId`） |
| `token_rotate` | 写 | `token.manage` | `/tokens/{tokenId}/rotate` | tokenId | 轮换访问令牌（明文只返回一次）（写工具，要 `clientRequestId`） |
| `token_revoke` | 写 | `token.manage` | `/tokens/{tokenId}/revoke` | tokenId | 吊销访问令牌（写工具，要 `clientRequestId`） |

## 写工具的重试约定

带 `（要 clientRequestId）` 的工具，每次**逻辑上的**调用都必须带一个稳定的 `clientRequestId`；
超时重试要复用同一个值，24 小时内返回第一次的结果。不要每次重试生成新的 id —— 那等于重复下单。
