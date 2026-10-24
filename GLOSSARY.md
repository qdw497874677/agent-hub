# agent-hub

把用户在自有机器上运行的多种 AI agent，统一成同一个任务与会话模型，并让会话之间的派生与血缘关系可见、可恢复。

## Language

### 领域核心

**Task**：
一件要做的事，由人写下标题与目标，有明确的生命周期状态。
它是会话的**唯一来源**——没有 Task 就不存在 Session。一个 Task 可以派生多个 Session。
_Avoid_: 任务单、Ticket、Issue、Job

**Session**：
一次持续的对话，绑定在**恰好一个** Task 上，承载消息、工具调用、审批、停止与产出。
Session 是可恢复的：关闭客户端后重新打开，历史与运行状态仍在。
_Avoid_: 会话（作动词时含糊）、Chat、Conversation、Thread

**Agent**：
一个可被调用的 agent 实例，由「接入档 + 具体 agent + 模型配置」三部分组成。
Agent 声明自己支持什么（见**能力矩阵**），平台按声明渲染能力，不按 agent 名字写死判断。
_Avoid_: Bot、助手、Model、Provider

**Artifact**：
Session 或 Task 的产出物（文件、diff、报告、链接）。
Artifact 挂在产生它的 Session 上，可被所属 Task 汇总；它是产品闭环的终点，不是副产物。
_Avoid_: 附件、Output、Result

**Project**：
绑定一个本地目录的作用域容器，容纳 Task。
它是**作用域边界**，不是行为丰富的聚合：除了「Task 属于哪个 Project」，它不承载领域行为。
_Avoid_: 仓库、Repo、Workspace

### 关系

**Derive**：
从一个 Task 创建 Session。派生出的 Session 与同 Task 的兄弟 Session 相互独立、可并行、上下文不共享。
_Avoid_: 新建会话（丢失去向）、启动、Run

**Fork**：
从一个 Session 复制出新的 Session，血缘上记录来源 Session 与**固定的事件游标**。
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

**Pairing Token**：
允许一个 Worker 加入某个 Server 的一次性凭据。
_Avoid_: API Key、密钥、token（单独使用）
