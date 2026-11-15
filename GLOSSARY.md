# agent-hub

把用户在自有机器上运行的多种 AI agent，统一成同一个任务与会话模型，并让会话之间的派生与血缘关系可见、可恢复。

## Language

### 领域核心

**Task**：
一件要做的事，由人写下标题与目标，有明确的生命周期状态。
它是**工作型会话**的来源：一个 Task 可以派生多个 Session；群角色与 bot 的常驻会话不属于任务（见「容器会话」）。
_Avoid_: 任务单、Ticket、Issue、Job

**Session**：
一次持续的对话，承载消息、工具调用、审批、停止与产出。
它**可以**属于一个 Task（工作），也可以不属于（容器会话：群角色、bot 私聊）。
Session 是可恢复的：关闭客户端后重新打开，历史与运行状态仍在。
_Avoid_: 会话（作动词时含糊）、Chat、Conversation、Thread

**Agent**：
一种可被调用的 agent 运行时的自我描述（`AgentDescriptor`）：能力矩阵、模型清单与可调项，由适配器上报，没有自己的生命周期状态。
运行中的一次调用是 **Session**，不是 Agent。可复用的启动配置是 AgentProfile，团队级、按项目授权的自动代理是 Bot，三者不要混称。
平台按能力矩阵渲染能力，不按 agent 名字写死判断。
_Avoid_: Bot、助手、Model、Provider、实例

**Bot**：
团队级的一等智能体：有自己的 @id、运行时与启动选项，**不隶属任何项目**；通过「项目授权」进入项目（可分别指定每个项目里的默认工作空间）。
授权到项目后才能被 `bot:<name>` 寻址、进该项目的群、在该项目的任务里开会话；撤销授权等于把它移出该项目。
_Avoid_: 项目 bot、角色（role 是群里的发言身份，不是实体）

**Artifact**：
Session 或 Task 的产出物（文件、diff、报告、链接）。
Artifact 挂在产生它的 Session 上，可被所属 Task 汇总；它是产品闭环的终点，不是副产物。
_Avoid_: 附件、Output、Result

**Project**：
容纳 Task 的作用域容器。
它是**作用域边界**，不是行为丰富的聚合：除了「Task 属于哪个 Project」，它不承载领域行为。它不绑定目录——目录是 **Workspace** 的事。
_Avoid_: 仓库、Repo、Workspace

**Workspace**：
某台 Worker 上的一个真实目录，Session 在里面干活。
`long_lived` 由人建立、跨 Task 复用，平台不删；`temporary` 归一个 Task，任务结束后确认没有未保存改动才清理。
一个长期 Workspace 可以被多个 Project 使用，关联记在 `ProjectWorkspaceLink` 上，不靠类型字段。
_Avoid_: 仓库、Repo、Project、工作区（含糊）

**Preview**：
把 Session 所在 Worker 上的一个回环端口映射到 hub 的一个监听端口，让人打开正在跑的本地服务。
一条 Session 最多挂 8 条，每条有自己的 id 与 `ready / stale / offline` 状态，不进会话 journal。
_Avoid_: 端口转发、Tunnel、分享链接

**容器会话（Container Session）**：
不挂任务、随配置生灭的常驻会话：群角色会话（属于某个群成员）与 bot 私聊会话（属于某个 Bot）。
判据只有一条：`taskId === null`。它不进任务列表、不占任务配额，生命周期跟群成员或 Bot 走。
_Avoid_: 假任务、常驻任务、系统任务

**渠道（Channel）**：
一个外部系统怎么接进来、怎么发回去（Slack、飞书、GitHub、邮件）。渠道只懂协议，不懂权限。
_Avoid_: 连接器（那是产品打包名，不是领域对象）、Integration

**目标（Target）**：
一条绑定的落点：`session`（主会话 / 每次新会话）或 `group`（某个群）。目标决定投到哪里，不决定怎么投。
_Avoid_: 目的地、Destination

**会话收件箱（SessionInbox）**：
唯一回答「这条会话现在能不能接新的一轮」与「这一轮结束后谁该收尾」的东西。
各投递方（私聊、群聊、连接器、调度、送达队列）注册成来源，判断集中在收件箱，不在各自代码里。
_Avoid_: 队列、Delivery（那只是其中一个来源）

**出站队列（Outbox）**：
会话要发到外部渠道的回复先写这里：带租约、退避重试、回声去重，由 pump 投递。
智能体没有 `slack.reply` 之类工具——回复原会话只走出站队列。
_Avoid_: 发送队列、Webhook 队列

**Actor**：
「谁授权、以谁的名义」的冻结快照（`{ userId, via }`），在发工具授权时写入，工具调用按它实时求权限。
_Avoid_: 身份、User（那是账号本身）

### 关系

**Derive**：
从一个 Task 创建 Session。派生出的 Session 与同 Task 的兄弟 Session 相互独立、可并行、上下文不共享。
_Avoid_: 新建会话（丢失去向）、启动、Run

**Fork**：
从一个 Session 的**最新处**复制出新的 Session，血缘上记录来源 Session 与当时的 `lastSeq`。
传入的游标会被忽略：底层 agent 不能按中间某一步分叉，挑中间会让上下文和标记对不上（ADR 0012）。
来源 Session 之后的续写不会自动进入 Fork 目标的上下文。
_Avoid_: 复制、Clone、Branch

**Lineage**：
Session 之间的派生与 fork 关系，以及 Task→Session 的归属关系的总称。
Lineage 是后端持久化的领域事实，不是画布的视觉属性——画布只是它的一种投影。
_Avoid_: 关系图、图谱、依赖

**Canvas**：
Task 与 Session 及其 Lineage 的可交互视图。节点是**真实的会话交互表面**（可直接阅读、发送消息、看到流式输出），不是静态缩略图。
画布只投影 Lineage 与运行状态，不成为数据权威，不替代会话列表与搜索。
_Avoid_: 白板、看板、Dashboard、流程图

### 接入

**接入档**（Access Tier）：
平台接入一个 agent 的深度，只有两档。
**L2**：adapter 把该 agent 的执行事件归一成平台统一事件（消息、工具调用、审批、取消、终态），平台因此能管理会话。**这是基线。**
**L1**：把 agent 的原生终端界面嵌入平台并托管进程，平台只能观察屏幕、不能解析事件，因此**不能 fork、不能作为 Lineage 的一端、不能结构化检索**。
_Avoid_: 集成级别、适配模式、L1/L2/L3

**能力矩阵**（Capability Matrix）：
每个 Agent 声明的一张能力表（是否支持 fork、是否产生结构化事件、是否可参与 Lineage 等）。
它取代「按 agent 类型分支」的代码，是产品「可拓展」这一说法的**可验收定义**。
_Avoid_: 特性开关、feature flag、兼容表

### 部署角色（不是领域概念）

**Server**：
状态权威、路由与协调的运行时角色。**适配器，不是领域概念**——领域层不认识它。
_Avoid_: 后端、主节点、控制面

**Worker**：
agent 进程实际运行的一台机器及其守护进程，通过主动出站连接加入 Server。**适配器，不是领域概念**。
_Avoid_: 节点、Node、客户端、Executor、Runner

**落点（Placement）**：
一条会话、一个项目被绑定在哪台 Worker 上（`workerId`）。会话一旦开始就不换落点，续聊、分叉都回到同一台；
项目的落点就是它目录所在的机器，项目里开的会话都落在那台。`null` 表示 hub 所在这台。
_Avoid_: 调度到节点、分配 Runner

**Pairing Token**：
允许一个 Worker 加入某个 Server 的一次性凭据。
_Avoid_: API Key、密钥、token（单独使用）
