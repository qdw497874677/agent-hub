# 群聊：反应、正在输入、流式回复

状态：设计中（2026-11-14）。用户要求（m08519）：「群聊消息,如果谁要回复，对要回复的消息增加反应……并且要回复的成员可以有一个消息，描述为正在输入，并且流式返回，并且渲染md」。

## 1. 要解决什么

现在群聊里成员发言是**整段落库**：`packages/domain/src/use-cases/groups.ts:443` 在成员回合结束后才 `append(...)`
把 `lastTurnText()` 拼好的整段文字贴进群。于是：

- 人发完话后到第一条回复之间，群里没有任何「有人接到了」的信号；
- 成员在生成时，群里看不到正在写的内容；
- 消息以纯文本渲染（`apps/web/src/surfaces/im/messages.tsx:389` 的 `whitespace-pre-wrap`），markdown 不生效。

## 2. 语义

1. **反应（reaction）**：任何能看到群的人都能给任意非系统消息加/撤表情；成员被派到要回复时，自动在「它要回的那条消息」上加 👀，等它的回复落地（或失败/沉默）后换成 ✅ 或撤掉。
2. **正在输入（typing）**：当天投递状态是 `delivered`（已经送进成员会话、还没收尾）时，这个成员算「正在输入」，期间它的增量文字实时显示。
3. **流式 + markdown**：草稿气泡在生成过程中按增量刷新，正文用现有的 `LogMarkdown`（`react-markdown` + `remark-gfm` + `skipHtml`，不渲染原始 HTML）渲染；最终帖子仍然整段落库，入库后草稿消失。

## 3. 数据模型

```ts
// packages/domain/src/groups.ts
export interface GroupReaction {
  readonly emoji: string;
  readonly actor: { readonly kind: 'user' | 'agent'; readonly name: string };
  readonly createdAt: number;
}
export interface GroupDelivery {
  // 新增（可选，老数据没有）：
  /** 自动反应挂在哪个帖子上（被回复的那条）。 */
  readonly reactTo?: string | null;
}
```

- 允许的表情固定在 `packages/domain/src/groups.ts`：`GROUP_EMOJI = ['👍','👀','🎉','✅','❤️','😄','🤔'] as const`，自动反应用 `👀` / `✅`。
- 每条帖子返回聚合后的 `reactions: { emoji, actors: {kind,name}[] }[]`，按首次出现时间升序。

### 存储

新表（`packages/storage-sqlite/src/groups.ts`，追加到 `GROUP_SCHEMA`，`CREATE TABLE IF NOT EXISTS` 即可，无需迁移）：

```sql
CREATE TABLE IF NOT EXISTS agent_group_reactions (
  group_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, actor_kind, actor_name, emoji)
);
CREATE INDEX IF NOT EXISTS agent_group_reactions_post ON agent_group_reactions(group_id, post_id);
```

`GroupStore` 新增：

```ts
reactions(groupId: string, postIds: readonly string[]): Promise<Map<string, GroupReaction[]>>;
addReaction(groupId: string, postId: string, actor: GroupReaction['actor'], emoji: string, now: number): Promise<void>;
removeReaction(groupId: string, postId: string, actor: GroupReaction['actor'], emoji: string): Promise<void>;
```

## 4. 接口

- `PUT /api/groups/:id/posts/:postId/reactions`，body `{ emoji }` → `{ reactions }`
- `DELETE /api/groups/:id/posts/:postId/reactions?emoji=…` → `{ reactions }`
- 权限：`group.post`（能发言就能反应）；系统消息（`author.kind === 'system'`）不支持反应，`400`；表情不在白名单 `400`。
- `GET /api/groups/:id/posts` 每条带 `reactions`（空数组也要有，前端不用判空）。
- `GET /api/groups/:id` 的 `GroupViewDto` 新增 `typing: { role, sessionId, since }[]`：由 `deliveries(threadId)` 里 `status === 'delivered'` 且会话仍在跑的那些投递算出来，不落库。

## 5. 自动反应

- `schedule()` 建立成员投递时把「被回复的帖子 id」写进 `GroupDelivery.reactTo`（主持人 / 竞价投递不写，它们不直接发言）。
- `pumpSession()` 把投递标成 `delivered` 之后：给 `reactTo` 加 `👀`，actor = `{ kind: 'agent', name: role }`。
- `settle(d, 'done' | 'silent' | 'failed' | 'canceled')` 之后：先撤 `👀`；`done` 时再加 `✅`（同一个 actor）。这样「谁要回」和「回完了」在触发消息上是可见的。
- 这些写入都在 `serial()` 的同一把群锁里，失败只记日志，不影响投递。

## 6. 前端

- 帖子正文：`LogMarkdown body={p.body}`，外部仍保留 `data-testid="group-post"`；系统行继续纯文本。
- 反应条：气泡下方一行小 chip（`group-reactions` / `group-reaction`，`data-emoji`、`data-mine`），点一下切换自己的反应；`＋`（`group-react-open`）展开 7 个表情（`group-emoji`），手机上点空白处收起。
- 正在输入：群头部下方一行 `group-typing`：「A、B 正在输入…」，数据取 `view.typing`，与草稿互斥（有草稿就显示草稿气泡）。
- 流式草稿：群页面复用 `useLiveStream()`（同一条全局 SSE，`apps/web/src/atoms/live.ts:33`），对 `view.typing` 里的 sessionId 取 `live[sessionId]`，把最后一条 `prompt` 之后的 `text` 增量拼起来，用 `LogMarkdown` 渲染成「正在输入」气泡（`group-draft`，带光标）。对应成员的正式帖子到了（帖子里的 `author.role` + `round` 命中）就不再渲染草稿。
- 纯逻辑放 `apps/web/src/atoms/group-live.ts`（拼草稿、撤销条件、反应聚合/切换），配套单测；`messages.tsx` 只做接线。

## 7. 不做什么

- 不做反应通知、不给反应做未读；不做表情搜索/自定义表情。
- 不做人「正在输入」（只有成员机器会话有可靠的 `delivered` 信号）。
- 不改群消息的轮询频率，也不给群单独开 SSE 通道——复用现有会话流。
- 草稿不落库，刷新后从头等正式帖子。
