# ADR 0037：项目工作台与 Bot —— 三层词汇

- 状态：接受
- 日期：2026-11-15
- 相关：ADR 0036（渠道 / 目标 / 投递内核）、ADR 0018（群聊）、ADR 0032（连接器）

## 背景

平台里「智能体」这个词被三种东西共用：

1. 引擎（OpenCode / Pi / Codex 这类运行时）；
2. 一次会话里的执行者（运行时 + 模型 + 选项，匿名、按会话生灭）；
3. 团队级、有名字、有记忆、可授权到项目、可进群、可被 @ 的实体（代码里的 `Bot`）。

同时「项目 / 工作空间 / 仓库」也被混用：项目是权限与代码边界，仓库是代码来源声明，工作空间是某台机器上的真实目录。

结果是：界面上一会儿叫「智能体」、一会儿叫「bot」，用户分不清「工作台里的智能体和 bot 有什么区别」；文档里 Project / Workspace / Repo 互相替代。

业界（2026）已经收敛到两层：`Agent` 指执行单元（OpenAI ChatGPT agent、Cursor agent、GitHub cloud agent），持久成员用另一个词（OpenAI `Workspace Agents`、xAI `Grok Bot` = durable AI teammate、Slack `AI teammates`、Atlassian `Rovo agents` = configurable AI teammates）。`Assistant` 已被 OpenAI 下线，不再承担成员语义。

## 决策

### 1. 三层词汇（自下而上）

| 层 | 规范名 | 含义 | 界面上怎么出现 |
| --- | --- | --- | --- |
| 引擎 | **Runtime 运行时** | OpenCode / Pi / Codex / Grok 等可执行体 | 「由 OpenCode 驱动」 |
| 智能体 | **Agent 智能体** | 上位词：运行时 + 模型 + 选项构成的执行者，按职责分两类（见下） | 具体场景用下面的子类名 |
| 执行单元 | **Session 会话** | 唯一持久的工作单元；属于 Task，或容器会话 | 「会话」 |

`Agent` 按**职责**分两类，这是本 ADR 的核心：

| 子类 | 名字 | 职责 | 特征 | 谁在用 |
| --- | --- | --- | --- | --- |
| 持久智能体 | **Persistent Agent = Bot** | 有身份、有长期记忆、可被 @、可授权到项目、可被定时/事件唤醒 | 团队级、常驻、跨会话；由 Agent 驱动 | 消息面、群聊、连接器、项目任务 |
| 任务智能体 | **Task Agent** | 为一次会话干一件活：写代码、跑命令、产出 artifact | 匿名、随会话生灭、不携带跨会话身份 | 项目工作台里的会话 |

规则：

- 两个子类是**同一套执行内核**（同一个 Runtime / Adapter / ToolGateway），差别在**职责与生命周期**，不是两套技术栈。
- 持久智能体之所以「持久」，是因为它有自己的 id、记忆与授权，而不是因为进程常驻；它的每次干活仍然是一个任务智能体（会话）。
- 界面词：Bot 就叫「Bot」；工作台里的执行者不单独露面（显示运行时与模型）。文档里需要对比时用「持久智能体 / 任务智能体」。

### 2. 两个产品面

| 面 | 定位 | 核心对象 |
| --- | --- | --- |
| **项目工作台（Project Workbench）** | 以项目为入口，为同一份代码分别创建多个会话，并行推进开发 | Project / Repo / WorkDir / Task / Session |
| **Bot（与消息）** | 有身份、可授权的常驻成员：私聊、进群、接外部渠道、被定时/事件唤醒 | Bot / BotGrant / Group / Channel |

两者不是上下级：**Bot 是「谁在干」，工作台是「在哪干活」**。工作台里的会话可以指定由哪个 Bot 驱动；Bot 也可以被叫进项目的群或项目任务。

`Team` 只是**权限边界**（谁被允许进来、谁能授权），不作为任何产品面的名字。

### 3. 目录相关名词

- **Project 项目**：代码与权限边界，只声明 `Repos`，不绑定目录。
- **Repo 仓库**：代码来源（url + 默认分支）。
- **WorkDir 工作目录**：某台 Worker 上的一次检出（`path` + `workerId` + `long_lived` / `temporary`）。
- **WorkDirGroup 组合工作目录**：多仓库一次检出（成员按 position，0 是主仓库）。

代码里现有 `Workspace` 暂不改名；先加 `export type WorkDir = Workspace` 别名，界面文案统一用「工作目录」。等 #221 收尾后做一次性改名（含 `AgentDescriptor → RuntimeDescriptor`）。

### 4. Agent 的构成：协议 + 适配 + 运行时

Agent 不是「一个 agent 程序」，而是三层拼起来的：

| 层 | 是什么 | 代码位置 |
| --- | --- | --- |
| **运行时 Runtime** | 真正被拉起的进程（OpenCode / Pi / Grok / Hermes / Codex），有版本、有自己的配置目录与插件 | `packages/adapters/<runtime>/` |
| **协议 Protocol** | 进程与 hub 之间的线协议：ACP（JSON-RPC）是默认；Codex 走自己的 `app-server` 协议 | `packages/adapters/acp/src/`、`packages/adapters/codex/` |
| **适配 Adapter** | 把协议消息翻成 Hub 的 `SessionEvent` / 工具调用 / 选项，并把运行时能力上报成 `AgentDescriptor` | `codec.ts`（接口）、`map-acp.ts`（标准 ACP）、`codecs/opencode.ts`（vendor 私有语义） |

规则：

- **协议适配是通用的，运行时是具体的**。新增一个运行时 = 新增一个 adapter（或复用 ACP + 一个 codec），不改 domain / hub / 前端。
- Adapter 只做协议映射与能力上报，**不做策略**（权限、配额、投递都在 domain）。
- 标准 ACP 不写进 vendor codec：`decode` 返回 `null` 就回退通用 mapper；只有 vendor 扩展（如 opencode 的 `child_update`）才在 `codecs/<vendor>.ts` 里实现。
- 命名上：说「运行时」时指引擎（OpenCode），说「模型」时指具体模型（`opencode/iceman-free`），**不要用运行时名指 Agent**。

## 后果

- 界面：导航分组为「工作台 / 消息 / 库 / 运维」；Bot 页标题用「Bot」；工作台不再出现「智能体」作为名词。
- 文档：GLOSSARY 按本 ADR 重写；「持久智能体」只作为 Bot 的**类别**出现（`Persistent Agent = Bot`），不再当作另一个实体。
- 代码：领域实体仍是 `Bot`；`Agent` 保持「执行者」语义（`AgentDescriptor` 描述运行时能力，不是成员）。
- 不做：不引入 `Teammate` / `Coworker` 作为代码或界面主词——业界用它是因为要出现在「@ 谁」的地方，而我们的 `Bot` 已经是那个 handle，改名只增加迁移成本。
