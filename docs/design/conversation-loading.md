# 对话加载与记录同步

参考 Orca 的 [移动端回合状态行](https://github.com/stablyai/orca/blob/a91fc0a676e324b2630a78bdc6d885f513cc9d88/mobile/src/session/native-chat/transcript/messages/MobileNativeChatLiveLine.tsx#L34-L73) 和[回放连续性检查](https://github.com/stablyai/orca/blob/a91fc0a676e324b2630a78bdc6d885f513cc9d88/mobile/src/session/native-chat/transcript/ingestion/mobile-native-chat-stream-frame.ts#L32-L60)。借鉴的是单条状态提示以及先校验、再合并的原则，不引入 Orca 的宿主协议。

| 要回答的问题 | 依据 | 显示 |
| --- | --- | --- |
| 历史读完了吗？ | 当前会话的完整 journal 已合并 | 读取中 / 读取失败可重试；未知时不显示「还没有说话」。 |
| 已有记录是最新的吗？ | SSE 的连接状态与会话的补齐状态分别记录 | 保留已经看见的记录；补齐中或失败可见。重新连上不等于已经补齐。 |
| 消息已经送达了吗？ | 本地发送 ID、持久送达记录、回执 | 继续区分发送、排队、送达与未知；补齐失败不替用户重发。 |
| Agent 正在做什么？ | 当前 prompt 之后的回合进度 | 时间线末尾共用一行。工具完成后只说在等待模型；审批、结果未知及记录未同步时不转圈；减少动效时用静态符号。 |

## 记录合并

沿用带 `seq` 的会话 journal 和共享 SSE。每个会话单独协调完整读取、按已应用游标补齐和同时到达的帧。读取期间缓存新帧，先确认 journal 序号连续，再按顺序合并；同序号的事件不会重复添加，单纯的状态帧也不推进游标。补齐失败保留可见记录，允许重试；旧连接上的请求返回时不能覆盖新一代的结果。重连、历史加载、发送状态都不会删除草稿或更改审批与停止语义。

完整历史仍走现有接口；本轮不改服务端协议或存储，历史分页和长会话性能属于独立问题。
