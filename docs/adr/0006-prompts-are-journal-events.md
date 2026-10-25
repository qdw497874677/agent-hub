# 6. 用户的提问进 journal，成为第七个事件变体

Status: accepted

## 背景

画布上的会话卡只画 agent 说的话。这没问题——卡片是「这条路走到哪了」的缩略图。

但验收时有人问：「现在我在什么地方可以和 agent 对话？」把一条会话打开整屏之后，
问题就露出来了：**整屏里只有回答，没有提问**。用户自己说过什么，平台一个字都没留。

根因在 `packages/domain/src/event.ts`：`SessionEvent` 的六个变体全部来自 agent
（text / tool_call / tool_result / artifact / ended / diagnostic）。prompt 走的是
`POST /api/sessions/:id/prompt`，只被转发给 worker，不进 journal。

于是「双权威」（ADR 0004 的前提）其实缺了一角：journal 声称自己是可检索历史的权威，
却记不住这次对话的另一半。

## 决定

新增第七个变体 `{ kind: 'prompt'; text }`，由**平台**在收到 prompt 时写入，
adapter 永远不产出它。

四条具体约束：

1. **先落盘，再叫 agent。** 反过来的话，agent 起不来时用户那句问话凭空消失，
   留下一句没有提问的回答。
2. **落盘走同一个串行队列。** agent 的推送和用户的 prompt 会撞同一个 `seq`
   （ADR 0004 的失败模式），所以 `createApp` 不再自己写 journal，而是接一个
   `record(sessionId, event)` 回调，由组合根接到 per-session 队列上。
3. **卡片不画 prompt。** `showsOnCard` 排除它；它在专注对话里才出现，
   靠着右侧的气泡位置表示「这是你说的」。
4. **fork 点包含 prompt。** 因为 seq 连续，`atSeq` 落在一次提问上时，
   分叉出来的会话带着那次提问——这是对的，人分叉通常就是想从某个问题重新开始。

## 为什么不是把 prompt 存在别处

- **存在会话表的一个字段里**：只能存最后一次。会话是可以来回很多轮的。
- **只存在前端**：刷新就没了，而「关掉浏览器重开还能认出昨天说服了什么」是定位 §8 的成功判据。
- **让 adapter 把用户的输入再推回来**：Pi 和 OpenCode 都不回显 prompt，两个 adapter 都要为
  同一件事各写一套——这正是 X1 要避免的重复。

## 后果

- `SessionEvent` 从六变体变七变体，成本是本文件与每个 adapter 的映射表都要重新看一眼。
  **adapter 侧不需要改**：新变体只有一个来源，就是平台自己。
- 搜索的 `session_text` 投影仍然只拼 `text`。要不要把 prompt 也拼进去是另一个决定：
  现在不拼，理由是「搜别人说过的话」和「搜我说过的话」是两种意图，混在一个 LIKE 里会互相稀释。
- 事件流抽屉多一种 `prompt` 行，`#seq` 因此不再全是 agent 事件——排障时这反而有用。
