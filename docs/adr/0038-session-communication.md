# ADR 0038：会话通信——一仓一会话的协作（感知 · 只读看对方 · 互发消息）

- 状态：accepted，已实现（2026-11-18 David 确认设计稿 §13 三项按推荐默认；P1a–P1f 合入 master `5b77631`，#245–#250；实现差异记在设计稿 §17）
- 关联：ADR 0018（agent 间通信，P1 已实现）、0031（送达队列）、0036（投递内核）、0015（对外 MCP）；设计稿 `docs/design/session-communication.md`；多仓 `docs/design/multi-repo.md`（#241）

## 背景

David 要两种多仓模式都支持：先做 Amp 式组合（#241），接着做「一仓一会话 + 会话之间能感知、只读看对方、互发消息」。

目标场景是外部 agent 只通过 MCP 开发多仓项目：开发会话在机器 A，验证会话在机器 B。开发会话推完分支后让验证会话启动验证，再拿回结果。

ADR 0018 的 P1（`MessageBus`、`agent.send / ask / reply`、连线可达、限额、不可信包裹）已经在代码里，但还缺这几样：
- 同伴的仓库、分支、机器信息；
- 只读看同伴的工作空间；
- 结构化附件；
- 外部发送方；
- 这个场景需要的防风暴规则和权限档位；
- 派生时选仓、选机器。

调研了 t3code（orchestration-v2：`delegate_task`、`t3_thread_send` 的 auto / queue / steer、`thread_wait`、权限天花板、`clientRequestId` 回执、线程只有通过 peer link 才能跨环境）和 Claude Code 跨会话消息（空闲唤醒、入站 hold、相同内容去重、按发送方限速），结论都是「消息 = 文本 + 引用，不共享文件系统；空闲唤醒、忙就排队；不能借别人的手绕过审批」。

## 决定

1. **扩展 ADR 0018，不另建消息系统。** 复用 `agent_messages`、`MessageBus.accept()`、`SessionInbox`。
2. **只有会话可以寻址。** 新增 `peer:<handle>`（任务内短名）和 `external:<inboxId>`（只作为回复目标）；worker 只是落点，不是地址。
3. **消息可达 = 显式连线 + 消息派生父子 + 同项目同任务树**（任务树为 2026-11-23 增补，详见下文）。`session_start` 加 `linkWith`、`handle`、`repoId`；`agent.spawn` 加 `repoId`、`workerId`、`handle`。
4. **信封扩展**：
   - `from`（会话 | 外部）+ `via`；
   - `parts`（`data` / `ref` / `file` / `link`，≤8 个，≤16KB）；
   - send 加 `wake`；ask 加 `timeoutSec`（≤4 小时）；reply 加 `status` 和 `data`。
   - 附件全部包在不可信边界里；`ref.repo` 必须是项目登记的仓库，`link` 只允许 http(s)。
5. **投递**：空闲唤醒、忙就排队（不变）；已收起的会话不唤醒，返回 `archived`；离线重试一次；回复唤醒提问方，工具结果带 `next` 提示。steer 放到 P2，按能力位开放。
6. **只读看同伴**：`workspace.list / read`、`git.state` 加 `session`，新增 `workspace.changes`；跨 worker 走现有 RPC。按 `onBehalfOf` 判断 `session.read` 和 `workspace.files.read`；敏感文件对 agent 一律不给；每次读都审计 `workspace.peer_read`。
7. **外部 agent**：对外 MCP 新增 `session_link`、`session_unlink`、`session_peers`、`session_message`、`message_get(waitSec≤50)`、`message_inbox`；`events` / `get_session` 加 `waitSec`。外部收件箱绑令牌族：轮换沿用，吊销关闭。本机 Worker 和跨团队一律拒绝。
8. **防风暴**：
   - 新增：同一对会话每分钟 6 条；10 分钟内重复内容拒绝；同一条链里往返 8 次、中间没有人说话就暂停等人；收件队列 20 条；每链消息唤醒最多 30 轮（到顶拒绝 `rate_limited`）。
   - 保留：深度 4、并发 8、扇出 10。
9. **权限档位**：从需要审批的会话（guarded）发给自动批准的会话（auto）时先拦下，等人放行；项目可以用 `trustPeers` 关掉。
10. **与组合的分工**：开发用一仓一会话，验证可以用组合会话一次拉起几个仓；两者用 `ref` 消息衔接。消息和审计不随 worktree 清理删除。

## 后果

- **正面**：
  - 增量小（大部分已有）；
  - 和 Git 的真实单位（一仓一 PR）一致；
  - 跨机器验证是自然的「问 / 答」；
  - 外部 agent 不需要回调地址就能完成全程；
  - 每一步都能按 trace 审计。
- **负面**：
  - 迁移 `agent_messages.from_session_id` 到判别联合，波及回复路径；
  - 对外多 6 个工具；
  - 多条会话总 token 更高；
  - 权限档位依赖运行时报告的审批设置，未知时不拦（P2 收紧）。
- **中性**：A2A 网关仍在 ADR 0018 P3；steer、token 预算、调用链视图放到 P2。

## 备选

- **把 worker 当地址（「发给机器 B」）**：否决。等于再造一套选模型、选目录、选人的编排。
- **只有显式连线才允许普通任务会话通信**：原首版决定；2026-11-23 允许同项目同任务树默认可达，不再要求为这类协作手动画线。
- **共享文件系统 / 跨会话写**：否决。破坏一仓一 worktree 的隔离，业界也没有这样做的。
- **外部 agent 只用 `session_reply` 和 `events`**：能做，但回复关联不上，也不受防风暴约束；保留作为「下指令」的路径。

## 2026-11-23 增补：同任务树默认可达

- 会话通信是 Hub 的定向消息能力，不依赖画布。同一项目内，绑定同一顶层任务树的会话默认可达，包括同任务、父子任务和兄弟子任务。根据已保存的父链推导，不创建会话链接；父链缺失、跨项目或成环时不推导。
- 显式连线不传递。解除显式连线不会移除任务树本身产生的可达性。同伴列表的 `relation` 表示可达原因，`connected` 仍只表示有显式连线。
- 消息可达不等于授权：同树新增同伴按实际查看者的 `session.read` 过滤；运行时发现和发送使用同一轮的代理人。现有工具权限、消息派生隔离和投递规则继续生效；任务树不赋予文件读写、会话控制或受限 worktree 子会话发信权限。主动回报、项目交接和外部消息不在本次变更范围内。
