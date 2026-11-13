# 前端分层：原子能力 + 可编排的产品形态

状态：提案（待确认，未动代码）
日期：2026-11-13

## 0. 一句话

底层只保留原子能力（会话、启动配置、可调项、群与角色、投递与待办），前端把它们编排成两个**产品面**：**工作台**（项目 / 任务 / 会话 / 画布 / 文件 / 终端）与**消息**（持久 bot / 群聊 / 投递 / 连接器）。分层靠 import 门禁约束，不靠约定。

## 1. 问题

现在的代码里，产品形态与原子能力没有界限：

- IM 的页面（`#/messages`、`#/bots`）已经和项目 Workspace 并列渲染（`apps/web/src/app.tsx:31-37`），但导航把它们塞进「我的」组（`apps/web/src/global-nav.ts:40-71`：`mine=[memory, messages, bots]`），用户看不出这是两个产品。
- 工作台反过来依赖 IM 模块：`apps/web/src/focus.tsx:1,3,204,598,764,875` 用了 `delivery-note.tsx` 的 `DeliveryContext/useDeliveries` 与 `attention.tsx` 的 `AttentionAutoAck`；`apps/web/src/chat-blocks.tsx:1` 用 `DeliveryNote`；`apps/web/src/inspector.tsx:8` 用 `SessionMessages`。这不是「工作台需要 IM」，而是「这些是会话运行态原子，被错误地放在了 IM 目录语义下」。
- 两套启动配置能力不对等（**已修**）：`PersistentAgent` 现在有 `options`（`packages/domain/src/messaging.ts:110`），`role-session.ts:56` 在派生时垫进会话；历史上 `AgentProfile`（`packages/domain/src/agent-profile.ts:6-16`）有 `options` 而 bot 没有。
- 前端 DTO 没进契约：`BotDto/GroupDto/DeliveryDto/AttentionDto/ConnectorNoticeDto` 手写在 `apps/web/src/api.ts:702-886`，`@agent-hub/contract` 里没有。
- IM 实体全部以 `projectId` 为外键（`packages/domain/src/messaging.ts:127`、`groups.ts:35`）：IM 不是独立聚合，而是「项目里的一个配置块」。

## 2. 分层

三层，各自只有一个职责：

```
shell/     应用壳：路由分派、导航、账号、共享设置入口、全局样式
surfaces/  产品面：im/（持久 bot + 群聊）、workbench/（项目 + 会话 + 画布 + 文件 + 终端）
atoms/     会话运行态与领域视图的原子组件：composer、options、model-picker、delivery、attention、session-messages、terminal、files
```

**原子层（atoms）**：不认识任何产品面，只认 `@agent-hub/contract` 的类型和自身的 props。典型成员：

| 原子 | 现状位置 | 归属理由 |
| --- | --- | --- |
| `composer.tsx` / `chat-blocks.tsx` | 已在根 | 会话输入与消息渲染，两层共用 |
| `options.tsx` / `model-picker.tsx` / `model-scope.ts` | 已在根 | 可调项与模型选择，两层共用 |
| `delivery-note.tsx` | 根 | 投递回执，任一会话都可能被投递 |
| `attention.tsx` | 根 | 待办相位，读时由事件派生（`packages/domain/src/attention.ts:57` `derivePhase`） |
| `session-messages.tsx` | 根 | 会话与其它 agent 的往来（ADR 0018） |
| `terminal-panel.tsx` / `terminal-core.ts` | 根 | 终端是会话能力，不是 IM 能力 |
| `files-browser.tsx` / `files-core.ts` | 根 | 同上 |

**产品面（surfaces）**：只做编排与导航，不新增领域概念。

- `surfaces/im/`：`bots.tsx`、`bot-connectors.tsx`、`messages.tsx`、`messages-entry.tsx`。
- `surfaces/workbench/`：`home.tsx`、`sidebar.tsx`、`canvas.tsx`、`focus.tsx`、`inspector.tsx`、`nodes.tsx`、`team-workspaces.tsx`。

**应用壳（shell）**：`app.tsx`、`route.ts`、`use-route.ts`、`global-nav.ts(x)`、`auth.tsx`、`providers-dialog.tsx`、`tokens-dialog.tsx`、`admin/*`。

### 2.1 编排：surface manifest

每个产品面导出一个 `manifest.ts`，壳只认 manifest，不认识页面细节：

```ts
// surfaces/im/manifest.ts
export const imSurface: Surface = {
  id: 'im',
  nav: [{ group: 'messaging', id: 'messages', label: '群聊' }, { group: 'messaging', id: 'bots', label: 'Bot' }],
  routes: [
    { page: 'messages', match: /^#\/messages/, parse: parseMessagesRoute, to: formatMessagesRoute },
    { page: 'bots', match: /^#\/bots/, parse: parseBotsRoute, to: formatBotsRoute }
  ],
  settings: [{ id: 'bot-connectors', label: 'Bot 连接器', component: BotConnectors }]
};
```

`shell/route.ts` 保留 hash 解析骨架，但每个面的 pattern 由 manifest 提供；新增一个产品面（例如「运维面板」）= 新目录 + manifest 注册，不改 `app.tsx` 的分派 switch、不改 `global-nav.ts` 的分组表。

## 3. 边界规则（可执行）

`scripts/check-import-boundaries.mjs` 的 `FILE_RULES` 已经支持「按文件路径正则限制允许/禁止的 import」，直接加四条：

```js
// atoms 不认识产品面
{ files: /^apps\/web\/src\/atoms\//, forbid: /^\.\.\/(surfaces\/|shell\/)/, why: '原子组件不认识产品面与壳' },
// 两个产品面不得互相 import
{ files: /^apps\/web\/src\/surfaces\/im\//, forbid: /^\.\.\/workbench\//, why: 'IM 面不得依赖工作台面' },
{ files: /^apps\/web\/src\/surfaces\/workbench\//, forbid: /^\.\.\/im\//, why: '工作台面不得依赖 IM 面' },
// 产品面只能通过 manifest 被壳编排
{ files: /^apps\/web\/src\/shell\//, forbid: /^\.\.\/surfaces\/(?!.*manifest\.ts$)/, why: '壳只认识 manifest 与页面出口' }
```

同时保留一条「迁移豁免表」：分期未搬完的文件先白名单放行，每个豁免要求写一句原因和移除期限，`check-selftest.mjs` 里加正反例，保证门禁本身不会假通过。

## 4. 原子缺口收敛（先做，不然分层是空壳）

1. **bot 的启动配置（已落地）**：`PersistentAgent.options?: Readonly<Record<string, string | boolean>>`（`packages/domain/src/messaging.ts:110`）；派生入口 `apps/server/src/role-session.ts:56` 透传给 `deriveSessionUseCase`，P2P / 群聊 / 连接器 / 调度器四处在 `apps/server/src/main.ts:262,279,342,375` 带上；编辑入口 `apps/web/src/surfaces/im/bot-options.ts` + `bots.tsx` 的「启动选项」。校验用现成的 `RuntimeOption` 形状（`packages/domain/src/option.ts:38-52`），**不新增一套选项定义**：键是 agent 上报的 configId（`effort`/`thinking`/`mode`），不是 category（`thought_level` 填进去会被拒）。启动时未知键告警后跳过，已知键的非法值仍让本次启动失败。
2. **DTO 进契约**：`BotDto/GroupDto/DeliveryDto/AttentionDto/ConnectorNoticeDto` 从 `apps/web/src/api.ts` 移到 `packages/contract/src/*`，web 只 import 契约。
3. **项目仍是共享基础设施**：IM 不新增独立聚合；`MessagingConfig.projectId` 与 `Group.projectId` 不变。产品面上把「项目」表述为「IM 的工作区」（文案层），底层不复制概念。
4. **持久 vs 临时**：已经是原子的（`RoleReuse`：`sticky | per-trace | always-new`，`packages/domain/src/messaging.ts:88-89`；会话 `Session.options` 是唯一权威），分层时只允许引用、不允许解释。

## 5. 入口与设置归属

| 设置 | 归属 | 入口 |
| --- | --- | --- |
| 个人设置 / 登录设备 / 访问令牌 | 账号（共享） | 账号菜单（`auth.tsx:491-520`） |
| 我的团队 / 角色 | 团队（共享） | 账号菜单（`auth.tsx:525-534`） |
| 模型提供商 | 运行时原子（共享） | 账号菜单（`auth.tsx:535-544`） |
| Agent 启动配置 | 运行时原子（共享） | 账号菜单 + 会话「保存为 Agent 配置」 |
| 机器 / 运行时 / 组件 | 运维（共享，clusterAdmin） | 后台「机器」页 |
| 项目设置 / 上下文策略 | 工作台面 | 侧栏 ⚙（`sidebar.tsx:199-206`） |
| Bot 身份 / 连接器 / 群设置 | 消息面 | `#/bots`、`#/messages` 页内 |

原则：设置入口按**原子归属**分，而不是按页面分；`AccountMenu` 留在壳里，任何一面都不复制（否则会出现双入口与状态不一致）。

## 6. 导航信息架构

导航沿用 `global-nav.ts` 的单一分组表，只改分组语义（不复制组件）：

- **工作台**：首页、项目（当前项目内的画布/列表/会话）
- **消息**：群聊、Bot
- **库**：记忆、工作空间、资产市场、可观测
- **运维**：运营后台（`clusterAdmin`，非管理员整组不渲染）

`memory` 从「我的」挪到「库」——它是跨会话的共享资产，不属于 IM。**可观测留在「库」**：`/observe` 在服务端没有角色门禁，放进运维组只会「看起来收口」，实际敲 URL 还能进；要真收口得先给路由加门禁。

组 id 同步为 `workbench | messages | library | ops`（`apps/web/src/shell/surface.ts`）。导航项「消息」在 UI 上叫「群聊」（组标题仍叫「消息」，避免同名），`data-testid` 仍是 `nav-messages`。窄屏 `<md` 时首页把全站导航排在项目列表之前（`order-*`），桌面顺序不变。

## 7. 迁移分期

| 阶段 | 内容 | 可独立验证 |
| --- | --- | --- |
| M0 | 本文档 + 门禁规则 + 豁免表骨架（此时豁免覆盖全部未搬文件） | `npm run check` 通过，故意加一条违规 import 必须失败 |
| M1 | 目录搬迁：atoms / shell / surfaces 三段（纯移动 + import 路径） | 单测、`build`、`typecheck:web` 全绿，页面手测无回归 |
| M2 | DTO 进契约；`api.ts` 只做请求 | `check`（包边界）通过 |
| M3 | IM 面收拢：`bots/messages/connectors` 只在 im 面；工作台不再 import 它们 | 门禁豁免表只剩 M4 相关条目 |
| M4 | bot 启动配置：`PersistentAgent.options` + spawn 透传 + bot 页编辑「启动选项」 | 新建 bot 会话带上 `effort`/`thinking`/`mode` 等 agent 真有的可调项（可测） |
| M5 | 导航重排（第 6 节）+ 文案统一 | e2e 导航断言更新 |

每阶段独立提交、独立部署，任何一阶段失败可回滚到上一个提交。

### 7.1 进展（2026-11-13）

| 阶段 | 状态 | 落点 |
| --- | --- | --- |
| M0 | 已落地 | `scripts/check-import-boundaries.mjs` 三条 `FILE_RULES`；`scripts/check-selftest.mjs` 14 项正反例（提交 `a0a5223`） |
| M1 | 已落地 | `apps/web/src/{atoms,shell,surfaces}`，151 个文件纯移动（提交 `c50cb5c`） |
| M2 | 已落地 | `packages/contract/src/messaging.ts`，web 只做同名转发（提交 `53107c0`） |
| M3 | 已落地 | `surfaces/{im,workbench}/manifest.ts` 声明导航与路由，`route.ts` 只留注册表与壳自己的页（提交 `b94867f`） |
| M4 | 已落地 | bot 启动配置，见第 4 节第 1 条（`packages/domain/src/messaging.ts:110`、`apps/web/src/surfaces/im/bot-options.ts`） |
| M5 | 已落地 | 导航四组（工作台/消息/库/运维）、文案统一（会话/机器）；窄屏首页导航前置 |

M3 之后「加一个产品面」的步骤是：建 `surfaces/<id>/manifest.ts` → 在 `route.ts` 的 `SURFACES` 加一行。壳的导航表、路由解析、门禁规则都不用改。

## 8. 验证

- `npm run check`（含新门禁与 selftest 正反例）
- `npm run typecheck` / `typecheck:web`
- `npm test`（当前基线 1127 tests / 1119 pass / 8 skipped / 0 fail）
- `npm run build`
- `npm run test:e2e-node` 6/6；涉及导航的 Playwright 用例（`e2e/canvas.spec.ts`、`e2e/admin.spec.ts`、`e2e/messages-entry.spec.ts`）
- 手测：390×844 手机与 1280×800 桌面各走一遍「工作台新建会话」「IM 群聊里 @bot」

## 9. 参考（外部产品）

### 9.1 Cursor

- 官方把界面重写成「以 agent 为中心」，并明确「随时切回 IDE」「继续投入 IDE」——IDE 只是众多界面之一，不是 agent 的宿主。来源：https://cursor.com/blog/cursor-3
- 两个顶端界面并列，而不是一个窗口里的模式切换：Agents Window（多仓库、多 agent 并行、worktree 隔离、diffs/PR）与 IDE，可同时打开。来源：https://cursor.com/docs/agent/agents-window
- 编辑器内部按能力强度分级：Composer 面板带 `composer_mode: "agent" | "ask" | "edit"` 与 Plan 模式；Tab 是行内补全，**走独立 hook 家族**（`beforeTabFileRead`/`afterTabFileEdit`），不是 agent 的一种模式。来源：https://cursor.com/docs/hooks 、https://cursor.com/docs/sdk/python
- **会话 ID 与表面无关**：`session_id` 与 `conversation_id` 相同，用 `is_background_agent` 区分云端/交互式——同一个 session 跑在不同 runtime 上。来源：https://cursor.com/docs/hooks
- 多通道共享同一会话库：iOS、cursor.com/agents、桌面、Slack `@Cursor`、GitHub/Bitbucket PR、Linear、API；「Agents you start anywhere appear in the mobile inbox automatically」。来源：https://cursor.com/docs/cloud-agent 、https://cursor.com/docs/cloud-agent/mobile
- Slack 的语义：频道里 `@Cursor` 新建 cloud agent；在该 agent 的线程里再 `@Cursor` 是对同一会话 follow-up；要另起必须明说 `start a new agent`；私聊用「Open in Web / Open in Desktop」搬会话。来源：https://cursor.com/docs/integrations/slack
- 设置分两轴且公开优先级：执行策略 `团队 dashboard > ~/.cursor/permissions.json + <workspace>/.cursor/permissions.json > IDE allowlist`，「Team settings take precedence over individual and project configuration」；run 级 `SendOptions`（model / mode / env / permissions）「becomes sticky for subsequent sends」。来源：https://cursor.com/docs/reference/permissions 、https://cursor.com/docs/sdk/typescript

### 9.2 Grok Bot

- Bot 是独立产品形态，不是聊天里的模式：上线时「its own separate app with Bots primary in the sidebar and conversations secondary」，现在也在 grok.com 侧栏有 Bots 区；Bot = 有名字、有云端电脑（桌面/文件/终端/应用）、7×24 常驻。来源：https://x.ai/news/introducing-grok-bot 、https://docs.x.ai/grok-bot/overview
- 持久 agent 的四个特征：可被 `@bot` 点名、有自己的 routines/triggers（定时、Slack 线程、GitHub PR）、bot 之间可互相触发、有 Team Bots / 手机 / MS Teams 入口。来源：https://x.ai/bot/guides/grok-bot-101 、https://docs.x.ai/grok-bot/skills-routines-and-automations
- bot 配置很薄（三个字段），权限是单独一层：Settings > General > Agent 的自然语言 allow/block 规则 + reviewer agent 做 allow/block/escalate。来源：同上。
- 聊天侧四层配置：Custom Instructions（全局）→ Custom Agents（具名人格，对话开始选择或中途按名字调用）→ Skills（`/command` 任务级）→ Workspaces（上下文隔离）。**人格 ≠ 会话**：人格是持久配置对象，会话是它的调用。来源：https://aitoolsrecap.com/Blog/grok-agent-settings-explained-2026 （第三方整理，非官方）

### 9.3 三条可复用原则

1. **会话是唯一的持久工作单元，产品形态只是客户端。** `session_id` 在 IDE / web / mobile / Slack / PR 之间恒定，跨端只做 handoff，不做复制；原子能力永远只在后端一份。
2. **设置拆成两条独立轴**：作用域轴（global → workspace → agent/persona → run）与强制轴（组织策略 > 项目配置 > 用户默认），并公开优先级。产品形态专属设置（布局、频道池）留在形态内；策略类（模型白名单、权限、沙箱）只能向上收。
3. **把「持久智能体」与「临时会话」建成 N:1 的两个资源**，而不是一个资源上的开关：Agent 有身份、地址（可 @）、工具、触发器、运行时；Session/Run 是对它的调用，携带本次覆盖（模型、模式、env）。设置入口自然分家：人格与触发器在 agent 页，本次覆盖在输入框，通知/记忆在账号层。

### 9.4 对本方案的影响

- 第 4 节的「bot 启动配置」按原则 3 落地：`PersistentAgent` 是那个 N:1 的「1」，`options` 是它的配置；`spawn` 时允许本次覆盖（会话级可调项），两处都用同一套 `RuntimeOption`。**`options` 只是建会话时的 seed**：派生后以 `Session.options` 为准（含 fork/rewind/continue 的快照），改 bot 默认值不追改已有会话。
- 第 5 节的设置归属按原则 2 落地：账号/团队/运行时尚在壳层（共享），项目设置在**工作台面**，bot/群设置在**消息面**；没有任何一面能自己新增「策略类」设置。
- 第 2.1 节的 manifest 是原则 1 的实现手段：壳不持有页面状态，产品面只是渲染与入口，原子能力仍只在后端与 atoms 一份。

## 10. 能力路线：从「可编排」到 grokbot 级形态

分层解决的是「形态怎么摆」，这一节解决「形态底下缺什么」。四块都属原子能力，缺任何一块，产品形态就只能靠产品面打补丁。

| # | 缺口 | 现状证据 | 落点 | 验收 |
| --- | --- | --- | --- | --- |
| C1 | ~~bot 没有独立身份与凭据~~（已落地） | `ApiToken` 加 `kind:'bot'` + `bot:{projectId,name}`（`ahb_` 前缀，只存哈希）；`decide()` 里做项目内收窄（`bot_scope`），有效权限 = scopes ∩ `BOT_PERMISSIONS`；签发 / 可见 / 吊销按项目 owner·admin；审计与来历写「以 bot「name」身份」 | 完成 | 冒烟：bot 令牌只能看见自己的项目、越界 403、不能建令牌、吊销即失效；bot 编辑页显示凭据（前缀 / 最近使用 / 生成 / 吊销） |
| C2 | ~~bot 没有启动配置~~（已落地） | `PersistentAgent.options` + 四处派生透传（第 4 节第 1 条） | 完成 | 新建 bot 会话带上 `effort`/`thinking`/`mode` 等可调项；真机冒烟 4/4 通过 |
| C3 | 触发器不是 bot 的一等属性 | 连接器按 `projectId` 挂（ADR 0032），bot 借用项目的 | 连接器加 `botName?` 归属；触发时按 bot 的 runtime binding 建会话 | bot 自己配一个定时/PR 触发，不依赖项目连接器 |
| C4 | 没有稳定的 bot 资源 API | 只有 `/api/projects/:id/agents` | `/api/bots`、`/api/bots/:name`（跨项目寻址，名字即 `@id`） | 外部集成方按名字引用 bot 不随项目迁移失效 |

两条对外通道必须落到同一批 domain 用例：

- 外部集成：HTTP + `ahp_` token（已有）。
- agent 自身：工具 / MCP endpoint（已有 `agent.*` 工具族）。

产品形态只做三件事：入口、编排（拿哪些原子拼在一起）、呈现。任何一面都不许新增「策略类」设置，也不许绕过用例直接读写库——否则「配置出形态」就退化成「配置出分支」。

与第 9 节三条原则的对应：C1/C2/C4 是原则 3（持久智能体与临时会话是 N:1 两个资源）的基建；C3 是原则 2（触发器属于 agent，本次覆盖属于会话）；「会话唯一持久」由 manifest 化（原则 1）保证——形态不持有会话状态。

### 10.1 C1 实现要点（2026-11-13）

- 身份不新开接口面：bot 凭据就是 `ApiToken` 的 `kind:'bot'`，走同一套 `/api` 与 `/openapi/v1`；`ahb_` 前缀只用来一眼认出来源。
- 收窄只有一处：`decide()` 的 2b 步——权限必须在 `BOT_PERMISSIONS` 内，碰资源时归属项目必须等于 `bot.projectId`（`Resource.projectId`）。只问能力的检查（如「令牌有没有 projects:read」）不要求项目。
- 新增 scope：`groups:write`（群发言）、`files:read`（会话工作空间文件）、`memory:read` / `memory:write`；旧的 `projects:write` 之类不会因为交集而放大。
- `worker.use` 在 bot 上限内（要过派发前最后一道），但开放 API 本来就不允许使用 hub 同机机器，bot 同样如此。
- 审计 / 来历：actor 名字写成 `<签发人> · bot「name」`，审计 detail 写「以 bot「name」身份」。
