# 飞书 / Lark 渠道（C4 第一个真实 IM）

状态：实现中（2026-11-15）。上游设计见 `docs/design/channel-convergence.md`（渠道 / 目标 / 投递内核）、`docs/adr/0036-channel-target-delivery-kernel.md`。

## 1. 目标

飞书群里 @机器人 的消息，成为一个「入站事件」：命中某条 `ConnectorBinding`（`connector: 'feishu'`）后交给会话处理；会话回合结束后，回复通过现有 `channel_outbox` 发回**同一条消息的线程**。

不做：飞书文档/审批/日历等其它事件；不做多租户（v1 一份应用凭据）；不做卡片消息（纯文本，保留 Markdown 原文）。

## 2. 连接方式

选**长连接（WebSocket）**：飞书开放平台「事件订阅」里选「使用长连接接收事件」，`@larksuiteoapi/node-sdk` 的 `WSClient` 负责建连与重连。理由：阿里云 hub 没有公网回调所需的 HTTPS 域名与签名校验链路；长连接只需要出站网络，和现有 worker 的 WS 出站一致。

配置：

| 环境变量 | 说明 |
| --- | --- |
| `FEISHU_APP_ID` | 飞书应用的 App ID |
| `FEISHU_APP_SECRET` | 飞书应用的 App Secret |

只放在服务器 `server.env`（不提交、不打印）。两个都非空才启用；只配一个是启动错误。

## 3. 数据流

```
飞书群 @机器人
  → WSClient 事件 im.message.receive_v1
  → createFeishuSource：过滤（sender_type=app、message_type=text、binding.params.chatId）
  → ctx.emit(bindingId, { externalId: "<chatId>:<messageId>", text: untrusted(...) })
  → trigger_run（UNIQUE(binding_id, external_id) 去重）
  → 会话回合
  → channel_outbox(target {kind:'external', id:"feishu:<chatId>"}, replyToExternalId=<messageId>)
  → createFeishuSink：im.message.reply(message_id) 或 im.message.create(chat_id)
```

- 去重交给核心的唯一键，source 不自己再查一次。
- 外部文本一律 `untrusted()` 包引用块；`@all` 之类的控制指令不从外部消息里执行。
- 回复落 outbox：失败按 `isTransient` 重试（1s/5s/30s/…），永久失败进 `failed` 并可人工重放；回声由 `looksLikeEcho` 三层去重。

## 4. 权限

- 入站：沿用连接器现有模型——`ConnectorBinding` 的 `createdBy` 是授权人（用户已选「外部消息以绑定授权人身份执行」）；v1 另加白名单与限流（每个 binding 每分钟最多 6 条入站）。
- 出站：机器人只能回复触发它的会话；不提供 `feishu.reply` 这类工具给 agent 直接调用。
- 群/DM 目标（`BindingTarget.kind='group'`）仍未开放（#221 步骤 0 先拒绝创建），v1 只支持 `session` 目标。

## 5. 已知边界

- 飞书消息 id 只在会话内唯一，`externalId` 必须带 `chatId`。
- 长连接断开期间的消息不会补投（飞书不重放）——这是选长连接的代价；需要补投时改用回调 + 事件重试。
- 富文本（post）、图片、文件 v1 不处理，只回一条「暂不支持」。
- 一个应用只能被一个租户（团队）使用；多团队需要 `channel_conversation` 与按团队存凭据，留到 C4 之后。
