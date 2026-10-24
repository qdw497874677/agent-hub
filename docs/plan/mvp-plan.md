# MVP 实现计划

状态：草案 v1。配套 [定位](../product/positioning.md)、[用户故事](../product/user-stories.md)、[技术选型](../architecture/tech-stack.md)、[视觉方向](../design/visual-direction.md)、[ADR 0001](../adr/0001-rewrite-hexagonal-core-four-aggregates.md)

**建造方式：纵切。** 每个 milestone 都是一条穿过全部层的薄竖井，终点是浏览器里能看见的东西；不按"先把领域层写完、再写适配器、再写 UI"的顺序推进。理由是端口划得对不对只有穿过一次才知道，分层施工会在发现端口形状错误时已经写完大量依赖它的代码。

---

## 1 不可协商的约束

四条，来自定位 §7 与本次决定。任何 milestone 都不许为赶进度临时破例——破例的代价不在这周，在三个月后。

| 约束 | 判定方式（可检查，不是口号） |
|---|---|
| **六边形：依赖方向单向** | `packages/domain` 的 `package.json` 里 `dependencies` 必须为空；`domain/**` 的 import 只允许自身相对路径与白名单 `node:` 模块。CI 脚本校验，见 §2.3 |
| **外部依赖可替换** | 每一处外部接触面（SQLite、Pi 进程、OpenCode 进程、ws、文件系统、HTTP）必须在一个适配器内闭环。判据：**删掉任一适配器包，`packages/domain` 仍能编译通过** |
| **端口定义先于实现** | 端口签名只用领域类型；端口文件不 import 任何适配器、任何 Zod、任何 DB 类型。返工信号：某端口的参数里出现 `Row` / `Request` / `JSON` |
| **简洁代码** | 具体规则见 §3，全部可机械检查或一眼判定 |

## 2 端口层

### 2.1 清单与归属

| 端口 | 定义在 | v1 实现 | 备注 |
|---|---|---|---|
| `TaskRepository` | `domain/ports/` | `storage-sqlite` | 含 layout 持久化 |
| `SessionRepository` | `domain/ports/` | `storage-sqlite` | journal 的 `(session_id, seq)` 游标在这里 |
| `ArtifactRepository` | `domain/ports/` | `storage-sqlite` + 文件系统 | 元数据入库，内容落盘 |
| `AgentRuntime` | `domain/ports/` | `adapters/pi`、`adapters/opencode` | **新增 agent 只实现这个** |
| `SessionEventStream` | `domain/ports/` | `apps/server` 内的 WS 广播 | 被驱动 |
| `NodeGateway` | `domain/ports/` | `node-gateway` | **双向**：接收执行事件 + 下发指令 |
| `NodeProvisioner` | `domain/ports/` | **空实现（抛「未实现」）** | T2 |
| `CapacityPolicy` | `domain/ports/` | **空实现（抛「未实现」）** | T2 |
| `WorkspaceFS` | `domain/ports/` | `node:fs` 薄封装 | 目录校验、Artifact 落盘 |

### 2.2 签名草案（写第一行业务代码前定稿）

```ts
// AgentRuntime —— 拓展性的唯一入口
export interface AgentRuntime {
  readonly descriptor: AgentDescriptor; // 含能力矩阵，UI 只认它，不认名字
  start(spec: StartSpec): Promise<RuntimeSession>;
}

export interface AgentDescriptor {
  readonly id: AgentId;           // 'pi' | 'opencode' | ...
  readonly label: string;
  readonly capabilities: CapabilityMatrix;
}

export interface RuntimeSession {
  readonly sessionId: SessionId;
  prompt(text: string): Promise<void>;
  interrupt(): Promise<void>;
  events(): AsyncIterable<SessionEvent>;
  /** 双权威对齐：告诉适配器「平台权威历史到此为止」，由它负责把上下文续上 */
  adopt(cursor: Seq): Promise<void>;
  dispose(): Promise<void>;
}
```

```ts
// SessionEvent —— 归一化的代价上限：六个变体，加变体要过 ADR
export type SessionEvent =
  | { kind: 'text';      delta: string }
  | { kind: 'tool_call'; name: string; input: string }
  | { kind: 'tool_result'; name: string; ok: boolean; durationMs: number }
  | { kind: 'artifact';  path: string; bytes: number }
  | { kind: 'ended';     outcome: 'done' | 'interrupted' | 'failed'; reason?: string }
  | { kind: 'diagnostic'; level: 'info' | 'warn' | 'error'; text: string };
```

**`SessionEvent` 是产品最贵的类型。** 每个 adapter 都要把厂商事件映射到它；变体越多，新 adapter 的映射成本越高（X1 直接受它影响）。所以只有六个变体，且 UI 只消费前四种——`diagnostic` 只进事件流抽屉，`ended` 只改状态位。

### 2.3 强制手段（不靠自觉）

三个脚本，都在 CI 里跑，每个不超过 50 行、零依赖：

1. **`check-domain-purity`**：遍历 `packages/domain/**/*.ts`，用正则取 `from '<spec>'`，断言 spec 以 `.` 开头或是白名单 `node:` 模块；再断言 `domain/package.json` 无 `dependencies`。
2. **`check-import-boundaries`**：`apps/*` 之间互不 import（只许 import `packages/*`）；`packages/*` 之间按 §2.1 的依赖表放行，其余拒绝。
3. **`check-port-signature`**：`domain/ports/**` 内出现 `Row` / `Request` / `Response` / `zod` / `sqlite` 字样即失败。粗暴，但正是要挡的东西。

### 2.4 Adapter 一致性测试（X1 的自动化形态）

`packages/contract` 里放一组 **conformance fixtures**：每个 fixture 是"某 agent 的一段原始事件序列 + 期望归一化出的 `SessionEvent[]`"。每个 adapter 包必须跑通同一套 runner。

于是 X1 不再是人工对照清单，而是：**新 adapter = 1 个包 + 1 张能力矩阵 + 1 组 fixture，跑通 conformance suite 即通过。** 第六条 milestone 的验收不再依赖我或你的记性。

## 3 简洁代码规则

写在文档里是为了能被指着说"这条你违反了"。每条都能一眼判定：

1. **用术语表里的词。** `Task` / `Session` / `Artifact` / `Derive` / `Fork` / `Lineage` / `Capability`。不用 `job`、`thread`、`conversation`、`run` 当同义词。
2. **领域层的函数是纯的**：吃领域对象，吐领域对象或 `Result`。不吃 `Request`、不吃 `Row`、不吃 `unknown`。
3. **错误用判别联合，不用异常跨边界。** 领域返回 `{ ok: true, value } | { ok: false, error: DomainError }`；异常只允许出现在适配器内部，在端口边界上转成 `DomainError`。
4. **不建垃圾场文件。** 禁止 `utils.ts` / `helpers.ts` / `common.ts` / `types.ts`。一个文件一个概念，文件名 = 它导出的主要类型。
5. **依赖注入只在装配处。** `apps/server` 与 `apps/worker` 的 `main.ts` 是唯一的 composition root；构造函数里不许 `new Storage()`。
6. **`any` 与跨边界 `as` 一律禁止。** 不可信输入（HTTP body、WS 帧、agent 输出）先在 `contract` 用 Zod 解析，解析后的类型才能进入适配器。`as` 只允许在同一窄化函数内、紧跟一次类型守卫。
7. **函数超 40 行或参数超 3 个，先拆再写。** 这是信号不是硬线。
8. **每个非显然分支要能指向一条用户故事或一篇 ADR。** 指不出来的分支就是没想清楚的代码。
9. **不加"以后可能用得上"的抽象。** 端口是例外，且已有清单；清单外的抽象要过 ADR。

## 4 Milestones

每个 milestone 的 gate 是**浏览器里点一遍能过的具体动作**，不是"代码写完了"。

### M1 · 一条命令，画布上有一个 Task

交付：`agent-hub up` 起 server + 本地 worker；深色画布（React Flow + 点阵 + 左下角线型图例）；建 Project（选目录、校验绝对路径存在）；建 Task；SQLite 落盘。

复用组件：`@xyflow/react`、Base UI（对话框/选择器）、`@fontsource`（IBM Plex Mono + Noto Sans SC）。

Gate：关掉浏览器重开，Task 与画布布局都在原位。对应 S1.1 / S1.2 / S2.1 / S2.2 / S4.1。
不许做：列表视图、搜索、任务排序、多 Worker 文案。

### M2 · Pi 接通：真实流式输出进卡片

交付：`adapters/pi`（`pi --mode rpc`、JSONL 帧、prompt/interrupt）；事件归一成 `SessionEvent` 并写 journal（`seq` 单调）；WS 下行；卡片内三种块型（对话 / 工具条 / 代码）+ 阶跃光标；模型选择与能力矩阵（三态 + 原因）。

Gate：在画布卡片里对真实仓库跑完一次 Pi 会话，工具调用与代码块正确显示，停止按钮让它进入明确终态。对应 S3.1 / S3.2 / S5.1 / S5.2 / S5.3。
不许做：fork、专注视图、Artifact 汇总、事件流抽屉。

### M3 · 并行与血缘

交付：同 Task 第二会话（各自独立 agent 进程，上下文不共享）；Fork（`origin_session_id` + `origin_seq`，并落 `(session_id, seq) ↔ agent_entry_id` 映射表）；实线/虚线血缘 + 拖拽持久化；专注视图（宋体不上，正文 13px 无衬线）。

Gate：一个 Task 下三条会话，其中一条 fork 自另一条；拖动后刷新布局不变；专注视图与画布来回切换不丢草稿。对应 S6.1 / S6.2 / S6.3 / S6.4。

### M4 · 还原、中断与产出

交付：重启后运行中的 Session 统一标「中断」（同一状态位、同字号）；可续写或终止；Artifact 挂 Session 并汇总到 Task；事件流抽屉（`diagnostic` 只出现在这里）。

Gate：把 worker 进程 `kill -9`，重开浏览器——历史完整、状态是「中断」而不是「运行中」、能接着发消息。对应 S7.1 / S7.2 / S7.3。**这一关不过，前三个 milestone 的价值全部作废。**

### M5 · 第二个 adapter：X1 的证明关

交付：`adapters/opencode`（`opencode acp` over stdio）；OpenCode 能力矩阵；conformance suite 双份 fixture；HTTP API（建 Task、派生 Session、读 Lineage、读 Artifact）。

Gate：OpenCode 会话跑通且 conformance suite 全绿；**同时 `git diff` 显示 `packages/domain` 与 `apps/web` 零改动**。若改了一行 `if agent === 'opencode'`，X1 判定失败——回头改端口，不打补丁。对应 S3.1 / X1 / X3。

### M6 · 收口

交付：安装脚本 + systemd user unit；`NodeGateway` 双向指令通道（Server→Worker 下发，为 T2 铺路）；Playwright 走完 7 步闭环；备份（拷 `.db` + Artifact 目录）。

Gate：在一台干净的同版本机器上，从 `git clone` 到画出第一个 Task 只要一条命令；Playwright 通过；定位 §8 那句成功判据由本人在浏览器里认一遍。

## 5 不进 MVP

| 项 | 去向 | 处理方式 |
|---|---|---|
| S8.1 第二台机器 | 闭环后第一个 milestone | 已在 [用户故事](../product/user-stories.md) 改标注，非静默砍掉 |
| L1 嵌入原生 TUI | T2 | tmux 控制模式；降级规则已写在定位 §5 |
| `NodeProvisioner` / `CapacityPolicy` | T2 | 端口在、实现抛「未实现」 |
| 认证 | 不做 | server 绑 `127.0.0.1` 无认证；**绑非 loopback 时无 token 则拒绝启动** |
| 列表视图 / 搜索 / 看板 | 画布之后 | 看板是反故事第 3 条 |

## 6 顺序理由（哪一步最可能推倒重来）

- **M2 是最高风险的一步**：`SessionEvent` 的六个变体要一次错对，因为它决定了每个后续 adapter 的映射成本。宁可 M2 拖长两天，也不要先随便定事件类型。
- **M4 是第二高风险**：双权威历史（平台 journal 管血缘与可检索，agent 会话文件管送给模型的上下文）在这里第一次被真正使用。`adopt(cursor)` 若在这里发现不成立，M3 的 fork 要重做。
- **M5 是体检**：它不改产品能力，只证明前四步的架构没走歪。这就是为什么它排在被验证的东西全部到位之后，而不是更早。

## 7 落地记录（M1–M6 全部实现后回填）

六个 milestone 的顺序按原计划执行，没有重排。以下是实施中与计划不同的地方——**计划的价值在于偏差可被记录**，不在它一开始就写对：

| 计划 | 实际 | 原因 |
|---|---|---|
| `AgentDescriptor` 里的模型清单由适配器写死 | 由 worker 启动时问 agent 自己（Pi 的 `get_available_models`），取不到就报空 | 裸模型名 `glm-5.3` 在多个 provider 已认证时被 Pi 拒绝（`ambiguous across providers`），平台补不出前缀。见 [ADR 0003](../adr/0003-model-list-comes-from-the-agent.md) |
| 派生会话必须带 model | 空 model 合法，等于「用 agent 自己的默认」 | 同上；强制选择只会逼用户面对一张不可信的表 |
| `Deps.agents` 是 `AgentCatalog{list(), runtime(id)}` | `{list(), descriptor(id)}` | 前者是把 worker 的进程塞进内核手里。server 只该有 `NodeGateway` |
| 画布首次加载即可派生 | agent 列表为空时画布 2 秒轮询，派生对话框如实显示「还没有节点上线」 | worker hello 比页面晚到（远程节点、模型探测都要时间） |
| `artifacts` 能力 Pi / OpenCode 都算 available | OpenCode 标 `limited`（ACP 工具结果无权威文件路径） | 只有 `rawOutput` 带绝对路径时才归档；假装能做会让产出物列表悄悄丢东西 |
| `fork` 能力全 available | 两个 agent 都标 `limited`，但平台血缘仍精确 | Pi 与 ACP 都没有「按 entry 分叉」的接口；血缘是平台自己的账，不依赖它们 |
| Playwright 预清理数据目录 | 不清理，用例用带时间戳的项目名自我隔离 | Playwright 会在 worker 进程里再求值一次 config，`rmSync` 会把 server 正在写的目录删成 unlinked fd——数据看着有、`sqlite3` 查不到 |
| — | Pi 的 stderr 与退出码进 `ended.reason`，卡片上显示原因一行 | 没有它，「失败」是个无法追问的状态 |

M6 的实际验收方式（可复跑）：

```bash
npm run ci     # 三层架构约束 + typecheck + 35 条单测
npm run e2e    # 真浏览器 + 真 Pi：建项目 → 建任务 → 派生 → 模型吐出带 run id 的字符串
```

`npm run e2e` 里那条断言是刻意收窄的：只认落在 `.react-flow__node-session` 里的文本。收窄之前它一度「通过」——匹配的是检查器里 textarea 的值。
