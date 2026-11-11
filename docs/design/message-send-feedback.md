# 消息发送反馈（Message Send Feedback）

> 状态：P0 已实现（前端乐观气泡）；P1（服务端快速 ack + clientMessageId 幂等）待做  
> 目标：发送后立即出现用户气泡和“发送中”状态，不再等 `api.prompt` 返回  
> 参考：OpenCode Web 的乐观用户消息、排队状态和失败恢复

## 1. 问题

当前发送链路是：

```text
Composer.send()
  → 清空输入框
  → await onSend()
      → Focus.run()
          → setBusy(true)
          → await api.prompt()
              → POST /api/sessions/:id/prompt
                  → promptSessionUseCase()
                      → 写 journal(prompt)
                      → 写 delivery(queued)
                      → ensureHosted()（可能冷启动/恢复，秒级）
                      → dispatch(prompt)
          → onChanged()
          → setBusy(false)
```

因此：

- 用户点发送后，输入框空了，但界面上没有立即出现“我刚才发了什么”；
- 冷启动、Worker 重连、`resume` 慢时，等待时间全花在 `api.prompt` 上；
- `run()` 把发送和其他操作混在一个 `busy` 里，发送期间整个输入区被禁用；
- 服务端已经把 prompt 写进 journal，但 UI 没有乐观层，是否显示取决于 stream 何时到；
- 发送失败时，用户只看到顶部错误，输入框内容不一定恢复，气泡也没有失败状态。

这不是模型慢，而是**发送确认和回合执行耦合在同一个请求/同一个 busy 状态里**。

## 2. 目标与非目标

### 做

1. 点击发送后，**同一帧**出现用户气泡（或“待发送”卡片），显示“发送中”。
2. 发送请求与回合执行解耦：HTTP 只负责“已接收”，不等待 Agent 冷启动。
3. 排队、发送中、已送达、失败四种状态可见且可恢复。
4. 失败时保留用户内容，可重试；重试不产生重复消息。
5. 不破坏现有送达队列、乐观排队区和 `DeliveryNote`。
6. 发送失败/断网时不丢草稿。

### 不做

- 不引入 WebSocket 之外的新实时协议。
- 不在客户端伪造 assistant 回复。
- 不改变“同一会话串行”的 queue 语义。
- 不在 P0 改服务端响应协议；P1 再做快速 ack。

## 3. 分层

保持现有边界：

- **Composer**：输入、附件、`/` 和 `@` 菜单；只负责“用户按了发送”。
- **Focus**：会话级 pending 状态、乐观气泡、重试、与 journal 对账。
- **API**：`prompt` 请求；P1 返回 `PromptAck`。
- **Domain**：写 journal、入 delivery queue、幂等；不关心 UI 如何显示。
- **Delivery**：真实的 queued/sending/delivered/failed 状态，仍由服务端权威。

不要在 Composer 里塞发送状态机；也不要让 domain 知道“气泡”。

## 4. P0：纯前端乐观发送

### 4.1 状态

```ts
interface PendingPrompt {
  id: string;                 // crypto.randomUUID()
  text: string;
  attachments: readonly AttachmentInputDto[];
  state: 'sending' | 'failed';
  error?: string;
  createdAt: number;
  baselineSeq: number;        // 发送前的 session.lastSeq
}
```

放在 `FocusView`：

```ts
const [pending, setPending] = useState<readonly PendingPrompt[]>([]);
```

### 4.2 发送流程

```text
Composer.send()
  → onSend(text, attachments)
      → Focus.sendPrompt()
          → 生成 client id
          → setPending([...pending, {state:'sending'}])
          → onDraftChange('')
          → 立即返回 true（输入框和附件清空）
          → void api.prompt(...).then(...)
```

`Composer` 不再 `await onSend` 到服务端返回；`onSend` 返回 `true` 表示“已接收并显示”，真正的网络结果由 Focus 处理。

### 4.3 显示

在时间线末尾、输入框上方渲染 pending 气泡：

- 样式与正常用户气泡一致；
- 标题旁/气泡下方显示 `发送中…`；
- `state='failed'` 显示 `发送失败 · 重试`，保留原文；
- `aria-live="polite"`，但不要重复朗读整段。

如果当前回合在跑，pending 气泡放在“待发送”区，而不是时间线顶部；等 journal prompt 到达后再进入正常时间线。

### 4.4 对账

收到 journal `prompt` 事件后：

- 如果 `seq > pending.baselineSeq` 且文本/附件匹配，移除对应 pending；
- 如果同时有多条相同文本，按 `createdAt` 顺序匹配最早一条；
- 如果服务端返回失败，保留 pending 并标记 failed；
- 如果 stream 暂时断开，`onChanged()` 后从历史 journal 对账。

P0 没有 `clientMessageId`，对账是启发式的；重复文本可能匹配错。P1 用稳定 id 解决。

### 4.5 busy 拆分

把现在的单一 `busy` 拆成：

- `sending`：本地有 pending 请求；
- `turnRunning`：Agent 正在跑（已有 `awaiting`）；
- `actionBusy`：重命名、选项切换、fork 等短操作。

发送按钮只受 `sending` 影响一小段时间，不能因为 `awaiting` 就禁止排队；现有 delivery queue 已经支持排队。

## 5. P1：服务端快速 ack + clientMessageId

P0 让用户“看得到”，但 `api.prompt` 仍可能等冷启动。P1 解决真实延迟。

### 5.1 协议

`promptRequest` 增加可选：

```ts
clientMessageId?: string
```

`POST /api/sessions/:id/prompt` 返回：

```ts
{
  ok: true,
  seq: number,
  deliveryId: string | null,
  state: 'queued' | 'sending'
}
```

HTTP 202，表示“已接收”，不表示 Agent 已完成。

### 5.2 domain

`promptSessionUseCase` 拆成两段：

```ts
enqueuePrompt() -> { seq, deliveryId, send: boolean }
attemptDelivery() -> 后台执行
```

- journal prompt 先落盘；
- delivery `queued` 先落库；
- 返回 ack；
- `attemptDelivery()` 通过 `deps.queue.run(sessionId, ...)` 后台执行，失败只更新 delivery/ended，不把 HTTP 请求变成 500；
- 失败时 UI 用 delivery 状态显示“未送达 · 立即重试”。

注意：如果 `ensureHosted` 失败，第一轮用户仍看到“已接收，发送失败”，而不是 HTTP 错误；这符合队列语义。

### 5.3 幂等

服务端按 `(sessionId, clientMessageId)` 去重：

- 同一 id 已存在：返回已有 seq/deliveryId，不重复写 journal；
- 客户端超时重试使用同一 id；
- 刷新页面后 pending 丢失，但服务端不会重复。

存储位置：

- prompt 事件增加可选 `clientMessageId`；或
- delivery payload 保存 `clientMessageId`，prompt 事件通过 seq 关联。

更干净的是 prompt 事件带 `clientMessageId`；它也是 UI 对账的权威键。

### 5.4 对账

- pending 收到 ack 后记录 `seq`，但**不要立即删除**；等 journal prompt 事件或历史刷新确认；
- journal 里出现相同 `clientMessageId` 的 prompt → 删除 pending；
- 如果 ack 超时：标 `unknown`，允许“重试”（同 id）或“放弃”；
- 不允许用文本匹配作为 P1 的主路径。

## 6. 视觉状态

| 状态 | 用户气泡 | 输入区 |
| --- | --- | --- |
| 点击后 | 立即出现，`发送中…` | 清空，可继续输入/排队 |
| queued | `排队中 · 等上一条送达` | 可继续输入 |
| sending | `发送中…` | 可继续输入 |
| delivered | 正常气泡，无状态 | 正常 |
| failed | `未送达 · 立即重试 · 撤回` | 保留草稿/可重试 |
| offline | 不乐观发送，提示离线 | 草稿保留 |

复用现有 `DeliveryNote` 文案，避免新增第二套状态词。

## 7. 文件边界

P0：

- `apps/web/src/focus.tsx`：`pending` 状态、发送、对账、渲染；
- `apps/web/src/composer.tsx`：`onSend` 不再等待网络结果；`sending` 与 `busy` 分离；
- `apps/web/src/chat-blocks.tsx`：可复用用户气泡渲染 pending；
- `apps/web/src/delivery-note.tsx`：失败/重试文案保持一致；
- 测试：`focus` 组件/E2E 断言点击后立即出现用户文本。

P1：

- `packages/contract/src/wire/http.ts`：`promptRequest.clientMessageId`、`promptAck`；
- `packages/domain/src/use-cases/conversation.ts`：enqueue/attempt 拆分、幂等；
- `packages/domain/src/event.ts`：prompt 事件可选 `clientMessageId`；
- `apps/server/src/http.ts`：返回 202 ack；
- `apps/web/src/api.ts`：`PromptAck`；
- 测试：重复 id 不重复落库、ack 在冷启动前返回、后台失败更新 delivery。

## 8. 验证计划

### P0

1. 点击发送后 100ms 内出现用户气泡和“发送中”；
2. 冷启动（mock `ensureHosted` 延迟 3s）仍立即出现；
3. 发送失败时气泡变“未送达”，可重试；
4. 连续发送两条：第二条在“待发送”区，第一条正常进入时间线；
5. 刷新后从 journal 恢复，不保留幽灵 pending。

### P1

1. `POST /prompt` 在 `ensureHosted` 前返回 202；
2. 相同 `clientMessageId` 重试只落一条 prompt；
3. 后台 `attemptDelivery` 失败 → delivery failed，UI 可重试；
4. 全量单测/关键 E2E。

## 9. 风险

1. **重复显示**：P0 文本匹配可能误判；P1 用 id 解决。
2. **HTTP 202 语义变化**：调用方不能再用 500 判断“Agent 发不出去”；需要看 delivery 状态。文档和测试要同步。
3. **后台任务生命周期**：Node 进程退出会丢未执行的 attempt；现有 delivery 轮询/重试应接管。
4. **队列顺序**：乐观显示顺序必须与 `seq` 顺序一致；不要按完成时间排序。
5. **长文本/附件**：pending 气泡只渲染本地副本，附件上传失败要单独标记，不能假装已发送。
