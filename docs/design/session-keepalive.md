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

## 4. 取舍与风险

- **内存**：每个会话常驻一个 agent 进程（opencode 量级几百 MB）。用空闲回收 + 每 worker 上限兜住；单机默认 8 个。
- **语义**：`idle` 不进入会话状态机，只是托管层信号，避免数据库里多出一个状态影响首页/画布筛选。
- **令牌**：后台任务可能需要工具/MCP，所以只能在真结束时吊销。
- **检查点**：`files.endTurn` 仍在回合结束时拍（它要的是"这一轮结束"），不随进程结束。
- **不做**（留给以后）：把子代理当成独立可订阅的会话流；`detach` 语义；跨 worker 迁移运行中进程。
