# 从 T3 Code 借什么（样式 / 交互）

调研对象：T3 Code（`pingdotgg/t3code`，MIT）。它把自己定位成「agent harness 的控制面」：本地 server 是唯一权威，浏览器 / 桌面 / 手机只是视图；概念只有 `environment → project → workspace → thread → turn`。

这份文档只列**要借的**和**明确不借的**，以及每条在我们仓库的落点。worktree 机制单独写在 `docs/design/worktree.md`。

## 1. 借：状态是注意力，不是一个布尔值

T3：侧栏每条 thread 直接标 `working / 等我批准 / 等我回答 / 完成`，并显示跑了多久；做完的 thread 可以 **settle**——不删，移出活跃列表，PR 合并或闲置 7 天自动 settle。

我们已有（ADR 0031）：`apps/web/src/atoms/attention.tsx` 的「等我处理」——`needs_approval` / `undelivered` / `failed` / `needs_answer` / `needs_review` 五个阶段，外加 `working` 计数，顶栏角标 + `(N)` 标题 + 首页收件箱，看过 3 秒自动 ack。

缺的是两件：

1. **列表里就能看到，不用进收件箱**：项目列表 / 画布的会话卡片补一行状态 + 已跑时长（`relativeTime` 已有），和 attention 的 phase 用同一套词。
2. **settle 语义**：我们的「稍后」是**时间性**的（同一 phase 再看一次就收起），没有「这件事我不再关注」的显式动作。补一个 `session.settle`（可 unsettle），列表默认折叠已 settle 的会话；自动 settle 条件先只做一条：**PR 已合并**。闲置自动 settle 先不做（我们还没稳定的「最后活动时间」口径）。

### 1.1 I1 已落地（2026-11-14）

用户可见的叫法是**收起 / 已收起**（不叫「沉淀」：容易被理解成记忆，见下）。

- 数据：`Session.settledAt`（`packages/domain/src/session.ts`，只表示「移出活跃列表」，不改状态、不杀进程）；SQLite 加 `sessions.settled_at` 列；`recentSessionSchema` 与画布投影都带上，首页最近会话对已收起的行做 `opacity-60` + 「已收起」。
- 用例：`packages/domain/src/use-cases/settle-session.ts` 的 `settleSessionUseCase`——`session.settle` 权限（默认 `own`）、跑着的会话拒绝（409「会话还在跑，先停止再收起」）、写审计 `session.settle`（detail 收起/恢复）。接口 `POST /api/sessions/:id/settle` `{settled: boolean}`。
- UI：会话菜单「收起：移出活跃列表」（运行中禁用并给原因）「移回活跃列表」；侧栏活跃列表与底部「已收起 N」两段；画布卡片 `data-settled` + 状态点 + 「已跑 N 分钟」（只在 working 时 30 秒推进）。
- 测试：`e2e/settle.spec.ts` 两条（收起→画布退到背景→从侧栏移回；运行中收起 409）。
- 口径：自动收起先不做（T3 的「PR 合并 / 闲置 7 天」我们等有稳定的「最后活动时间」口径再加）。

## 2. 借：控件贴着 composer，能力不匹配就诚实降级

T3：模型、推理强度、权限模式、workspace/branch 四个控件都在输入框旁边，不在设置里；某个 provider 没有某种权限模式时，界面直接说「会退化为询问」，而不是假装支持。

我们的模型 / 思考强度 / 工作空间选择已经在 composer 附近（`apps/web/src/atoms/options.tsx`、`workspace-chooser.tsx`），这条主要是补两条细则：

- 会话里任何「这次发送的额外条件」都放这里，不进设置页；设置页只放默认值。
- 能力不匹配时给一句人话，并且**在按钮旁边**，不要发完才报错（已有先例：`model-scope.ts` 的 `scopeNote`、`environment-notice.ts`）。

## 3. 借：`⌘/Ctrl+Enter` 发送并立刻给一个空 composer

T3：桌面端 `⌘/Ctrl+Enter` 把当前草稿发到**后台线程**，同时打开一个新的空 thread。节奏上变成「描述 → 甩出去 → 立刻写下一个」。

我们有 `Ctrl/⌘+Enter` 发送（`apps/web/src/atoms/composer.tsx:333`），但发完留在原地等回复。改法：`⌘/Ctrl+Enter` = 发送并**清空**（留在本会话，继续追加）；`⌘/Ctrl+Shift+Enter` = 发送到当前会话后跳到一个新建会话（同项目、同 agent、同工作空间）。后者在画布上等于「开一张新卡片」。

## 4. 借：三档 diff 作用域 + 行内评论

T3：同一份改动可以按「这一轮 / 整条分支 / 未暂存」三个作用域看；diff 行上可以直接留评论，评论带着选中的代码进下一次 prompt。

我们只有「改动」一个视图（`apps/web/src/shell/app.tsx:189-199` 的 → `/changes`、`:434-452` 的 `<ChangesPane>`）。补：

- 作用域切三个 tab：**这一轮**（journal 里本次 turn 的 touched files）、**整条分支**（会话 base 到 HEAD）、**未暂存**（工作区 dirty）。
- 行内选择 → 「带进输入框」：复用已有的 `@` 引用文件机制，扩展成 `path:start-end` 片段。

落点：`apps/web/src/atoms/files-browser.tsx` 的 `DiffView`（作用域入参）、`apps/web/src/shell/api.ts` 的 changes 接口加 `scope`，worker 侧复用现有 git 能力。

## 5. 借：侧聊（`/side`）不污染主线

T3：`/side <问题>` 在右栏开一个独立的问答 tab，用当前 thread 的上下文，但不写进主线；答完可以「带回」主线程。

我们的对应物是 fork（新会话 + 摘要交接），成本比「问一句」高得多。可以做轻量版：在会话页右侧 drawer（`inspector.tsx`）加一个「顺口问一句」，起一条 **`kind:'side'`** 的临时会话、继承当前会话的 context 快照，默认不落进项目列表。
这条收益明显但会动到会话模型，排在最后。

## 6. 不借

- **Full access 默认**：T3 把「不需要批准」设成新 thread 默认。我们的默认应当是保守的，权限模式本来就在 hub 侧统一判定（`packages/domain/src/access.ts`）。
- **四档权限模式照搬**：Supervised / Auto-accept edits / Auto / Full access 与我们的能力 + 审批模型不是一个维度；要借的是「不支持就降级并说明」。
- **另一套 thread 概念**：`Session` 已经是我们的唯一持久工作单元，再加一层只会分裂。
- **把 worktree 当安全边界**：它只隔离 checkout，不隔离机器；我们的边界是 worker + 目录白名单。

## 7. 分期

| 期 | 内容 | 落点 | 量级 |
| --- | --- | --- | --- |
| I1 | 列表状态行 + settle/unsettle（含 PR 合并自动 settle） | domain 用例 + 三处列表 | 0.5 天 |
| I2 | composer 手势（发送并清空 / 发送并新开） | `atoms/composer.tsx`、`focus.tsx`、画布 | 0.5 天 |
| I3 | 三档 diff 作用域 + 行内片段引用 | `files-browser.tsx`、`api.ts`、worker changes | 1.5 天 |
| I4 | 侧聊 `/side`（临时会话 + 带回） | domain `kind:'side'` + drawer | 2 天 |

每期都要过现有门禁（`npm run check` / typecheck / `npm test` / web 单测 / build / `test:e2e-node`），UI 改动补 Playwright 用例。
