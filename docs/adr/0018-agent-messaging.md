# ADR 0018：Agent 之间的通信——地址 / 信封 / 点对点 + 组广播，对外兼容 A2A

- 状态：proposed（待 David 拍板，见设计稿 §16）
- 日期：2026-10-30
- 关联：ADR 0006、0012、0015、0017；设计稿 `docs/design/agent-messaging.md`

## 背景

David 希望 worker 上的内部会话、经 `/openapi/v1` 接入的外部 agent 能互相通信，能力可授予到 worker 或项目，抽象要便于编排和扩展。业界调研（设计稿 §2）：跨组织互通已收敛到 A2A v1.0（IBM ACP 已并入）；MCP 是 agent 获得工具的通道（2026-07-28 版，Tasks 进扩展）；Actor 运行时（AutoGen）与消息系统（NATS、AGNTCY SLIM）都同时提供点对点和发布订阅；OpenAI Agents SDK / LangGraph 区分 handoff 与 agent-as-tool；Claude Code 用声明文件定义子 agent。

## 决定（提议）

1. 四层：**地址**（session / role 选择器 / group / external / user）→ **信封**（from、onBehalfOf、to、parts、correlationId、inReplyTo、taskId、trace{traceId,depth,path}、deadline、幂等键、budget）→ **原语**（send、ask、reply、cancel；组 post + replyPolicy none/any/N/all）→ **编排**（扇出汇聚、流水线、主管工人、投票，作为库 / 提示词，不进核心）。
2. 权限、限额、审计只挂在 `MessageBus.accept()` 一处；新权限点 `agent.message.send / agent.ask / agent.spawn / agent.role.manage / group.manage / group.post / agent.external.*`，授予到项目或 worker，与发起用户权限取交集；本机 Worker 仍只归集群管理员；默认禁止跨团队。
3. 被调方以发起用户身份运行，署名「agent X 代 David」；agent 发来的内容作为不可信数据包裹投递。
4. agent 入口 = 现有 hub MCP 上的新工具；收到的消息作为新一轮提问进入目标会话（忙时排队）；回复以 `agent_reply` 为主、轮末文本兜底。
5. hub 侧：`MessageStore` 端口 + SQLite 适配器（持久 outbox / 投递状态 / 重试），RuntimeAdapter 契约不变，SSE 推事件。
6. 对外：P3 实现 A2A v1.0 网关（角色发布为 Agent Card；外部 A2A agent 作为地址），trace / 深度 / 代理身份走 A2A 扩展；非 A2A 外部 agent 用开放 API 收件箱（SSE / webhook，CloudEvents 结构）。
7. 安全默认：深度 4、环检测、每链并发 8、扇出 10、派生 5、每链预算、派生新会话需批准。

## 后果

- 正面：一个小核心覆盖内部 / 外部、点对点 / 广播；与 A2A、MCP、CloudEvents 对齐，互通成本低；所有调用可审计、可追踪、可取消。
- 负面：新增 6–7 张表、一个投递后台；提问事件加 `author`；阻塞 ask 受 agent 端 MCP 超时限制。
- 中性：将来多实例可把 `MessageStore` 换成 Postgres / NATS JetStream。

## 备选

- 直接把 A2A 当内部模型：没有组、深度、代理身份；Task 一次性语义与长期会话不符。
- 引入 NATS / SLIM：单 hub 规模下运维成本不值。
- 只做编排 DSL / 工作流引擎：先有原语，再观察使用决定。
- ANP / DID：团队内单 hub 不需要去中心化身份。
