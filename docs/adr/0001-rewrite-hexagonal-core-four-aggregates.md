# 重写 agent-hub：六边形架构，领域核心只有四个聚合

**Status**: accepted

## 背景与决定

agent-hub 是重新设计与开发，不复用 wemux-lite 的代码与领域划分。架构采用六边形（ports & adapters），依赖方向单向：适配器 → 端口 → 领域。领域核心只有四个聚合——**Task / Session / Agent / Artifact**。**Server 与 Worker 是适配器，不是领域概念。**

## 为什么重写而不是重构

wemux-lite 的 `docs/design/` 有 30+ 份设计文档、合计约 80 万字符（`account-identity-system.md` 33K、`node-resource-distribution-architecture.md` 63K、`agent-collaboration-p2-architecture.md` 57K），9 个 package。这些文档不是为了团队与授权服务的，而团队与授权对 v1 的唯一用户价值接近零。重构的代价是把这套划分逐条拆除再重建，与重写成本相当，且中途没有可用的产品形态。

## 为什么 Server / Worker 必须降为适配器

wemux-lite 把 Server / Worker 当作架构一等公民（ADR 0001 `worker-is-the-only-agent-network-node`），后果是领域层被**安装形态**污染。最具体的症状：画布上必须决定「机器」节点算不算节点——而机器是运维信息，与产品价值（任务与会话的关系）无关。

把 Server / Worker 移到适配器层后，问题自动消失：领域层只知道 Task、Session、Agent、Artifact；「状态存在哪」「进程跑在哪台机器上」是 `NodeGateway` 端口背后的事。单机与多机因此成为**同一条路径**，区别只是 Worker 列表的长度，而不是两套模型。

## 为什么是这四个聚合

- **Task** 与 **Session** 是一对必须绑定的关系：Session 必须挂在恰好一个 Task 上。这条规则是产品的骨架——它使「无主的聊天窗口」在领域层就不可表达，而不是靠 UI 约束。
- **Agent** 独立成聚合，因为「支持不同 agent 并可拓展」需要载体。载体不是 `if agent == "pi"` 分支，而是 Agent 声明的**能力矩阵**，UI 按矩阵渲染。
- **Artifact** 独立成聚合，因为它是闭环的终点。若把产出物当成 Session 的字段，任务汇总与跨会话追溯都会退化成字符串拼接。

**Project 不是第五个聚合**，是作用域容器（绑定一个本地目录），只承载「Task 属于哪个 Project」，没有领域行为。

## 扩展点怎么留

原则：**扩展点只在「已经知道它会来、且现在划清边界成本低」的地方留，形式是端口在、实现空（返回「未实现」），不是半个实现。** 为说不清的功能预先设计接口，是另一种过度设计——wemux-lite 的文档体量就是这种过度设计的产物。

v1 的两个空实现端口：`NodeProvisioner`（自动下发安装）与 `CapacityPolicy`（资源管理）。它们直接约束了一处非显然的设计：**Worker 的连接与指令通道必须从第一天就支持 Server 向 Worker 下发指令**，而不只回传执行事件。现在多写一层是零成本，漏掉是重构级。

## 后果

- 新增一个 agent = 一个 adapter + 一张能力矩阵，内核与 UI 判断零改动（用户故事 X1）。
- 领域层依赖图 CI 可检查，Server / Worker 只出现在适配器层与装配处（用户故事 X2）。
- 代价：六个端口与四个聚合的边界必须在写第一行业务代码前定稿，前期设计成本高于「先写起来再说」。这是这次刻意买的单。
