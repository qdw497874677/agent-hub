# 智能体与群聊：先建智能体，建群只挑成员（设计稿）

> 状态：待评审，未实现。设计稿：[mockups/agents-and-groups.html](mockups/agents-and-groups.html)（`?s=agents|agent-new|group-new|group-new-adv|members|empty`），截图在 [mockups/agents-and-groups/](mockups/agents-and-groups/)。

## 问题

现在的「消息」页（`apps/web/src/messages.tsx`）把两件事放在同一个表单里：`GroupForm` 建群，下面紧跟 `RoleForm` 现场造「项目角色」（角色名 / agent / 模型三个输入框）。结果：

- 建群像在填配置，用户分不清「角色」就是持久智能体；
- 智能体只能在建群页创建，没有列表、不能编辑描述、不能删除；
- 手机上一屏塞两个表单，很乱；
- 群里只能通过 @ 外人再点「加进群」来加成员，不能移出。

## 业界做法（公开资料）

几乎所有产品都把「造机器人/智能体」和「拉进对话」分成两步：

| 产品 | 创建在哪 | 怎么进群/对话 |
|---|---|---|
| Slack | 在 [api.slack.com/apps](https://api.slack.com/quickstart) 建 App，装进工作区 | 频道里 `/invite @bot` 或频道设置「添加应用」（[帮助](https://slack.com/help/articles/202035138-Add-apps-to-your-Slack-workspace)） |
| 飞书 | 开发者后台建应用并开启机器人能力（[文档](https://open.feishu.cn/document/client-docs/bot-v3/bot-overview)） | 群设置 → 群机器人 → 添加机器人，从已有列表里选（[自定义机器人](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)） |
| Discord | [Developer Portal](https://discord.com/developers/docs/quick-start/getting-started) 建 Application / Bot | 用 OAuth 邀请链接把 Bot 加进服务器，再按频道授权 |
| Coze / 扣子 | 「工作空间 → 智能体」单独创建、调试、发布（[文档](https://www.coze.cn/open/docs/guides)） | 发布到飞书、微信等渠道，或在多 Agent 模式里引用已有智能体 |
| Dify | 「工作室」里建应用/Agent（[文档](https://docs.dify.ai/)） | 发布后被嵌入或在工作流里作为节点引用 |
| ChatGPT | GPTs 在「我的 GPT」里单独创建（[帮助](https://help.openai.com/en/articles/8554397-creating-a-gpt)） | 对话里 @ 某个 GPT 拉进来；Projects 只是收纳对话和文件（[帮助](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)） |
| AutoGen / CrewAI | 先定义 Agent（名字、模型、system message）（[CrewAI Agents](https://docs.crewai.com/concepts/agents)） | `SelectorGroupChat(participants=[...])` 只传已有 agent 列表，选择发言者的策略是群的属性（[AutoGen](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html)） |

共同点：**智能体是一等资源，有自己的管理页；群只保存成员引用和发言规则**。发言策略、主持人、轮数这类参数属于群，不属于智能体，且默认值够用，通常收起。

## 方案

### 1. 项目级「智能体」页

- 入口：项目导航新增「智能体」标签（与任务、文件、记忆并列）；路由 `#/p/:projectId/agents`。
- 列表：头像、名字、`@id`、运行时、模型、一行职责；能当主持人（已选模型）的标「可主持」。桌面两列卡片，手机单列。右上「＋ 新建」，支持搜索。
- 新建 / 编辑（手机全屏页，桌面居中表单）：
  - 头像（预设颜色 + 首字，后续可上传）；
  - 名字（显示名，可中文，随时改）；
  - `@id`（群里 @ 用，`[a-z0-9_-]`，**建好不能改**，从名字自动生成拼音/英文建议）；
  - 运行时：Pi / OpenCode / Grok / Hermes 分段选择，显示在线 worker 数；
  - 模型：下拉，留空用默认；主持人必须选模型；
  - 职责说明（作为系统提示）；
  - 高级：会话复用（sticky / per-trace / always-new），默认收起。
- ⋯ 菜单：编辑、私聊、删除。删除时列出它所在的群，确认后从这些群移出。

### 2. 建群

- 只填两样：**群名** + **成员多选**（勾选列表 + 顶部已选 chip，可点 ✕ 去掉），显示「已选 3 / 最多 8」。
- 列表下方「没有合适的？＋ 去新建智能体」，新建完带着已填内容回到建群页并自动勾上新建的那个。
- **高级设置** 默认收起，收起时一行摘要（「产品经理主持 · 最多 6 轮 / 30 条」）；展开后：谁来接话（主持人分配 / 自由举手）、主持人（只列已选且有模型的成员，默认第一个可主持的）、最多轮数、最多条数。
- 空状态：项目没有智能体时，成员区换成插画 + 「新建智能体」主按钮，「建群」置灰。

### 3. 群成员管理

- 群页「成员」按钮：手机底部抽屉，桌面右侧面板。
- 当前成员列表：头像、名字、`@id`、运行时、状态（空闲 / 正在回复 / 已暂停）；非主持人可「移出」；主持人需先换人。
- 「从智能体添加」：多选不在群里的智能体，按钮显示「添加 N 个」；提示「新成员只看到加入之后的消息」（与现有 addMember 不重放语义一致）。
- 保留现有的「@ 外人 → 加进群」快捷入口。

## 数据模型与 API 改动

结论：**沿用「项目角色」作为持久智能体，主要是挪 UI**，后端只需小幅补齐。

现状：
- 角色存在项目的 messaging 配置里（`MessagingConfig.roles: AgentRole[]`，`{ name, description, agentId, model, reuse }`），只有整表读写 `GET/PUT /api/projects/:id/messaging`，权限 `agent.role.manage`。
- `name` 同时是身份和 @ 名（`/^[a-z0-9][a-z0-9_-]{0,39}$/i`），群的 `members` / `hostRole` 存的是 name 字符串。
- 群：`POST /api/projects/:id/groups`、`PUT /api/groups/:id`、`POST /api/groups/:id/members`（只能加），权限 `group.manage`。

需要的改动：
1. `AgentRole` 加可选字段 `displayName`、`avatar`（颜色或图片 id）。`name` 继续当 `@id`，不可改，避免群成员引用和历史消息失效。旧数据 `displayName` 缺省显示 `name`。
2. 加单条接口，避免整表 PUT 互相覆盖：`POST /api/projects/:id/agents`、`PUT/DELETE /api/projects/:id/agents/:name`（内部仍写同一份 messaging 配置，权限 `agent.role.manage`）。旧接口保留。
3. 删除智能体：返回/处理引用它的群（已决定：确认后自动移出，主持人置空，见下）。
4. `DELETE /api/groups/:id/members/:role`（`group.manage`），主持人不能直接移出；`POST /members` 支持一次传多个。
5. 前端：新增 `agents.tsx` 和路由；`messages.tsx` 删掉 `RoleForm`，`GroupForm` 改成成员勾选 + 折叠高级设置；`MembersPanel` 加添加/移出。
6. 「职责说明」现有 `description` 上限 500 字，作为系统提示可能不够，建议放宽到 4000。

## 已决定（David，PR #167 评审）

1. **命名**：底层模型叫「持久智能体」（代码 `PersistentAgent`，由 `AgentRole` 改名，`AgentRole` 留作兼容别名）；**界面上统一叫「bot」**——导航 tab「Bot」、按钮「新建 bot」、提示文案都用 bot。下文和稿图里的「智能体」在界面上一律读作 bot。
2. **@id 建好不可改**，显示名可改。
3. **项目级**：bot 属于项目，不做团队级共享。
4. **头像**：颜色 + 首字（6 色：amber / sage / sky / rose / olive / slate），不做上传。
5. **职责说明**：上限放宽到 **4000 字**，并作为该 bot 的系统提示注入（群里的成员 / 竞价提示最前面的 `<agent-instructions>`）。
6. **删除被群引用的 bot**：确认框先列出受影响的群（是主持人的会注明），确认后**自动从这些群移出**；是主持人的群主持人置空，群里贴一条系统消息。

### 落地说明

- 存储不变：仍写项目的 messaging 配置（JSON 数组），新增字段 `displayName` / `color` 都是可选的，旧数据原样可读，不需要表结构迁移；群成员仍按 `@id` 引用。
- 单条接口：`GET/POST /api/projects/:id/agents`、`PUT/DELETE /api/projects/:id/agents/:name`；读要 `project.read`，写沿用旧整表接口的项目更新权限。旧接口 `/api/projects/:id/messaging` 保留。
- 群成员：`POST /api/groups/:id/members` 支持 `{ roles: [...] }`；`DELETE /api/groups/:id/members/:role`，主持人和最后一个成员不能移出。
- 路由：`#/bots/<项目>`；`#/bots/<项目>/new` 直接打开新建表单（空状态和建群里的「新建 bot」链到这里）。
