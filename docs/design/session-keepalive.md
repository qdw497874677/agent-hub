# 会话保活：回合结束 ≠ 进程结束

## 1. 问题

opencode 的 `task` 子代理跑在**它自己进程里**。现在一条对话回合结束时：

1. `packages/adapters/acp/src/acp-runtime.ts:399` 在 `session/prompt` 返回后 push `{kind:'ended'}`；
2. `packages/node-gateway/src/worker-link.ts:918-935` 收到 `ended` 就 `break`、发 `status:'ended'`、`await session.dispose()`；
3. 进程被杀，仍在跑的后台子代理一起消失；
4. `apps/server/src/main.ts:846-851` 还顺手吊销了 provider 句柄、关掉了终端。

直接开 opencode（TUI）不会有这个问题，因为进程常驻。

## 2. 参照

Paseo（`getpaseo/paseo`）把 agent 的生命周期交给 daemon：客户端断开、回合结束都不影响 agent；子代理随父归档，必要时可以 detach。它的分界线是**「这一轮」和「这个 agent」两个概念**——我们之前只有 `ended` 一个。

## 3. 设计

### 3.1 三个状态

| 状态 | 含义 | hub 行为 |
| --- | --- | --- |
| `running` | 有回合在跑 | 保持托管 |
| `idle` | 回合结束、进程还在（**新增**） | 保持托管；不吊销令牌、不关终端；会话状态按库里已有值（通常是 `done`） |
| `ended` | 进程没了 | 收托管、吊销中转句柄、关终端、按现有流程收尾 |

回合级收尾（派工收尾、群聊收尾、检查点、送达队列、连接器）挂在 `idle` 与 `ended` 上，幂等；进程级收尾只挂 `ended`。

### 3.2 保活与回收

- 每个会话一个进程，回合结束后保留。
- 空闲回收：`HUB_SESSION_IDLE_MS`（默认 900000，15 分钟）从最后一次事件/最后一次提问起算；到点 dispose 并发 `ended`。
- 保活上限：每 worker `HUB_KEEPALIVE_MAX`（默认 8），超出按最久没活动先回收。
- 再次提问复用活进程；显式 `dispose_session`、worker 退出、hub 关闭都走真 dispose。

### 3.3 可见性（配套）

回合结束后如果仍有事件到达（后台子代理、工具输出），会话页显示「后台任务还在跑 · 12 秒前」，画布卡片加一个小圆点。60 秒没有新事件降级为「后台任务可能已结束」。判定逻辑是 DOM-free 的 `apps/web/src/atoms/background-activity.ts`，只看块序列，不新增轮询。

### 3.4 后台子代理的补洞（拉取）

ACP 的 `session/prompt` 是**回合作用域**的：opencode 在后台子代理还在跑时也会回 `end_turn`，之后它的 ACP 适配器**不再推任何 `session/update`**（直连原始 JSON-RPC 验证过：`RESP` 之后 45 秒零 NOTIF），子代理完成时注入父会话的总结只能靠 `session/load` 重放历史看到。

所以 worker 侧加了一层拉取（`packages/node-gateway/src/worker-link.ts` 的 `startResync`）：

- 触发：收到 `ended` 且 `pendingSubagents() > 0`（codec 统计未结束的子代理）。
- 节奏：每 `resyncIntervalMs`（默认 5000）调一次 `AcpSession.resync()` → `session/load({sessionId, ...sessionParams(cwd)})`，重放期间 `replaying=true`，事件进独立 `replayBuffer`，不混进正常队列。
- 退避：连续几轮重放都没新事件就把间隔翻倍（5s → 10s → 20s → 40s，封顶 60s）；只要 `pendingSubagents() > 0` 就一直等，不再「几十秒没新东西就放弃」（#217），日志写明「还在等 N 个子代理，间隔 Xs」。
- 去重：正文/思考按 `kind|subagentId|messageId` 的 **chunk 序号高水位**（重放会把多块合并，按文本或按块数都不稳）；tool 按 `subagentId|toolCallId|status|kind|index`；subagent 按 `id|phase`；commands 按名字。实时事件也记同一套指纹（`recordLive`）。
- 停止：子代理真实结束（父工具终态内容 / `child_update` 终态）、空闲回收、保活淘汰、`retire`、用户又发消息（`pauseResync` 先停并在途 load 落地再 `session/prompt`，因为 load 与 prompt 并发的 `session/update` 会交错）。
- 前端不需要轮询：新事件照常走现有 SSE，断线补帧已由 `api.events(sessionId, lastSeq)` 覆盖。

已知边界：opencode 的重放历史**不含**子会话更新，也不含 `<subagent state=…>` 终态，所以 `pendingSubagents()` 不会因为重放而变 0；没有终态事件时循环只能等到空闲回收（默认 15 分钟）或用户发言。重放里没有稳定 `messageId` 的正文一律不重发（宁可漏，重复灌历史更糟）。

## 4. 取舍与风险

- **内存**：每个会话常驻一个 agent 进程（opencode 量级几百 MB）。用空闲回收 + 每 worker 上限兜住；单机默认 8 个。
- **语义**：`idle` 不进入会话状态机，只是托管层信号，避免数据库里多出一个状态影响首页/画布筛选。
- **令牌**：后台任务可能需要工具/MCP，所以只能在真结束时吊销。
- **检查点**：`files.endTurn` 仍在回合结束时拍（它要的是"这一轮结束"），不随进程结束。
- **不做**（留给以后）：把子代理当成独立可订阅的会话流；`detach` 语义；跨 worker 迁移运行中进程。
- **不做**：让 agent 主动推后台结果（ACP 没有这个通道；如果以后 opencode 的 ACP 适配器支持回合外的 `session/update`，可以去掉 3.4 的拉取）。
