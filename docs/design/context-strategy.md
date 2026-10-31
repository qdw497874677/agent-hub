# 设计：会话上下文策略（ContextStrategy）与运行时接入等级

- 状态：**accepted**（2026-10-31，David 拍板见 §11；只有设计，没有代码）
- 日期：2026-10-31
- 关联：ADR 0020（本设计）、ADR 0019 / `docs/design/memory.md`（长期记忆）、ADR 0013 与 `docs/design/runtime-adapter-contract.md`（RuntimeAdapter 契约）、ADR 0017（权限）
- 来由：David（2026-10-31）：「是不是可以统一抽象为上下文策略，可以是默认只有自动压缩，可以是 acp，可以是一些其他有名的策略」；拍板时又定「acp上下文先不做」。

> **命名说明**：仓库里已有的 `acp` 运行时适配器（`packages/adapters/acp`）指 **Agent Client Protocol**（下文写「ACP 协议」），和 billion-context-pi 的 **Active Context Pruning**（下文写「主动上下文剪枝」，策略 id 定为 `context-pruning`）毫无关系。文档、代码、配置一律用这两个不会混淆的名字，不单独用「ACP」指代剪枝策略。

## 0. 结论先说

1. **会话内的上下文管理**（这一轮给模型看什么）和**长期记忆**（跨会话记住什么，`MemoryService`）是两件事，分成两个端口。新端口叫 `ContextStrategy`。
2. **每个会话恰好一个策略**：不叠加，有明确的单一所有者。选择顺序是 会话 > 角色 > 项目 > hub 默认。
3. 内置策略：
   - (a) `compaction`：默认，到阈值时用摘要替换旧内容，就是现在的行为；
   - 暂不内置其他策略（David：「acp上下文先不做」）；
   - 候选适配器（以后再做）：主动上下文剪枝 `context-pruning`（调研参考 billion-context-pi / acp-kernel）：滑动窗口截断、工具结果清理、MemGPT 式分页、保留最近 N 轮 + 摘要。
4. 运行时用**三种上下文模式**接入：
   - `hub-managed`：运行时允许 hub 在每次调用模型前改写上下文；
   - `native`：运行时自己管上下文，hub 只观察、记录；
   - `runtime-plugin`：策略装在运行时自己的插件系统里，hub 负责下发配置、观察。
   
   新增运行时仍然只需要**实现一个适配器**，并声明它支持哪些模式。
5. **接入等级**：
   - L1：每个适配器必须做到——观察用量、压缩事件、导出会话记录，能触发压缩或重启，记忆走 hub MCP 工具；
   - L2：可选能力，即上面的 hub-managed 或 runtime-plugin；
   - L3：不要求，运行时内部机制和它自己的记忆文件，hub 只读、只索引。
   
   「统一接入」= 所有运行时都达到 L1。
6. **策略可以注入引导文字**（例如压缩说明、用量提醒），这属于**策略 / 政策**，不属于记忆，所以不违反 ADR 0019「记忆只用工具读」。前提是：内容来自管理员安装的策略版本（trusted），不能包含任何记忆条目，有长度上限，并且要审计。
7. 策略版本由管理员控制：锁定版本，**不自动更新**。

## 1. 为什么要和长期记忆分开

| | ContextStrategy（会话上下文） | MemoryService（长期记忆，ADR 0019） |
|---|---|---|
| 管什么 | 这一次调用模型时，消息列表长什么样 | 跨会话、跨项目留下什么 |
| 生命周期 | 跟着会话；会话结束，旁路状态就归档 | 独立于会话 |
| 所有者 | 每个会话一个策略 | 按作用域（user / role / project / group / session） |
| 能否注入 | 可以注入策略自己的引导文字（政策） | 不注入，只用工具 |
| 产出 | 压缩块、摘要（带消息 id 范围） | 条目（带出处） |
| 关系 | 它的产出是提炼（ADR 0019 §6.1）的**输入**之一 | 从策略产出提炼候选条目 |

## 2. 调研（2026-10-31）

### 2.1 主动上下文剪枝（`context-pruning`，候选、暂不做）：billion-context-pi / acp-kernel（只读 README 和包页，没读源码）

来源：[pi.dev 包页](https://pi.dev/packages/billion-context-pi)（已核对，内容与仓库 README 一致）、[billion-context-pi 仓库](https://github.com/ranxianglei/billion-context-pi)（只能看到简介）、[acp-kernel 仓库](https://github.com/ranxianglei/acp-kernel)（只能看到简介：「压缩内核，独立，零运行时依赖」）。

已核对的要点：
- **接管位置**：拦截 pi 的 `context` 事件（每次调用模型前触发），跑一条 8 步流水线：分配 ref → 同步块 → 剪枝 → 过滤 → 隐藏调用 → 推荐 → 提醒 → 紧急截断。**pi 自带的自动压缩会被取消，插件成为唯一的上下文管理者**。
- **稳定消息 id**：每条消息带一个对模型可见、对用户不可见的 ref（`m00001`…），模型用 ref 指定压缩范围。
- **由模型决定压缩**：工具 `compress`（把连续一段替换成详细摘要）、`decompress`（恢复，可逆）、`search_context`（不解压就能在压缩块里搜）、`acp_status`、`acp_cache`、`acp_rule`（可选：记一条压缩后也保留的原则性提醒）、`acp_delegate*`（可选：干净上下文的子 agent）。
- **分层**：摘要可以继续压，T1 → T2 → T3。
- **保护**：`compress` 调用本身硬保护；最近 N 条（默认 5）和约 5K token 软保护（`read` / `bash` / `decompress` / `search_context` 的结果不算在内）；最后一条用户消息一直保护；可以配置要保护的工具（`protectedTools` / `protectedLatestTools`）。
- **原始记录不动**：压缩状态放在会话日志旁边的 `.acp.json` 里（有 `schemaVersion`，原子替换）；没有这个文件时，**重放日志里成功的 `compress` 调用即可重建状态**。
- **引导文字**：压缩指南放在系统提示词里，**每一轮都注入**；接近上限时注入用量提醒（nudge），nudge 会记成只显示、不发给模型的条目。
- **同一会话只能有一个压缩插件**：README 明确警告两个压缩插件会互相破坏（pi 没有插件优先级）；与它自家的代理同时运行时会自动让位。这是本设计「每会话恰好一个策略」的直接依据。
- **其他接入方式**：opencode 用 `opencode-acp`（进程内插件）；其他客户端用 `billion-context` 代理（`bili <client>` 启动器或 `/bili/` 前缀的 base URL），在代理里跑同一条流水线。
- README 宣称的效果（「单会话能处理 100 亿到 600 亿累计 token」「成本约为传统压缩的 1/5」）**未独立验证**，只作背景。

### 2.2 其他知名策略（候选适配器）

| 策略 | 做法 | 来源 | 核对 |
|---|---|---|---|
| 自动压缩（摘要替换） | 到阈值时把旧内容换成一条摘要；Claude Code 有 `/compact [focus]` 和自动压缩；Codex 有 `model_auto_compact_token_limit` 和 `compact_prompt`；pi 有自动压缩和 `compact` | [Claude Code 工作原理](https://code.claude.com/docs/en/how-claude-code-works) · [Codex 配置参考](https://developers.openai.com/codex/config-reference) · [pi RPC](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/rpc.md) | 已核对 |
| Claude API 服务端压缩 | 在 token 阈值或按需压缩，可以保留最近几轮 | [Compaction](https://docs.claude.com/en/docs/build-with-claude/compaction) | 已核对（beta） |
| 工具结果清理（context editing） | `clear_tool_uses_20250919`：超过阈值时清掉旧的工具结果，支持 `keep`、`clear_at_least`、`exclude_tools`；`clear_thinking_20251015` 清理思考块 | [Context editing](https://docs.claude.com/en/docs/build-with-claude/context-editing) | 已核对 |
| 滑动窗口 / 截断（保留最近 N 轮） | OpenAI Agents SDK 的 `TrimmingSession`（`max_turns`） | [Session memory cookbook](https://cookbook.openai.com/examples/agents_sdk/session_memory) | 已核对 |
| 最近 N 轮 + 摘要 | `SummarizingSession`（`keep_last_n_turns`）；SDK 内置的 `OpenAIResponsesCompactionSession` | 同上 · [Sessions](https://openai.github.io/openai-agents-python/sessions/) | 已核对 |
| LangGraph 修剪 / 摘要 | `trim_messages`（按 token 修剪）、`RemoveMessage`（删除消息）、`SummarizationNode`（摘要） | [LangGraph add memory](https://docs.langchain.com/oss/python/langgraph/add-memory) | 已核对（只核对了名称） |
| MemGPT 分页（虚拟上下文） | 参照操作系统的分层内存：主上下文 + 外部存储，模型用函数换入换出 | [MemGPT 论文 arXiv 2310.08560](https://arxiv.org/abs/2310.08560) · Letta memory blocks（ADR 0019 已核对） | 已核对 |

## 3. 端口：ContextStrategy

```ts
// packages/domain/src/ports/context-strategy.ts

/** hub 给每条消息分配的稳定 id，跨压缩、跨重启不变（类似 billion-context-pi 的 m00001）。 */
type MsgId = string;
interface MsgRange { from: MsgId; to: MsgId }

interface ContextBudget {
  windowTokens: number;          // 模型的上下文窗口
  usedTokens: number;            // 最近一次的实际用量（由运行时上报）
  reserveTokens: number;         // 给输出和工具留的空间
  softLimit: number;             // 例如 0.7 × window，到了开始提醒或压缩
  hardLimit: number;             // 例如 0.95 × window，到了紧急截断
}

interface ContextView {
  messages: ReadonlyArray<{ id: MsgId; role: 'system' | 'user' | 'assistant' | 'tool'; content: unknown; tokens: number; tool?: string }>;
  guidance: string[];            // 策略注入的引导文字（政策），见 §6
}

interface StrategyState { schemaVersion: number; data: unknown }  // 旁路状态，必须能由重放重建

interface ContextStrategy {
  readonly id: string;           // 'compaction' | 'trim' | 'context-pruning' | 'tool-clear' | …
  readonly version: string;      // 管理员安装的锁定版本
  /** 需要运行时支持哪些模式；只支持 'native' 的策略就是「只观察」 */
  readonly modes: ReadonlyArray<'hub-managed' | 'runtime-plugin' | 'native'>;

  /** 钩子 1：每次调用模型前改写上下文（只在 hub-managed 模式下调用）。必须是纯函数：只依赖原始记录 + state + budget */
  transform?(input: { transcript: ContextView; state: StrategyState; budget: ContextBudget }): Promise<{ view: ContextView; state: StrategyState; events: StrategyEvent[] }>;

  /** 钩子 2：触发压缩时（阈值、用户 / 管理员手动、运行时上报的原生压缩） */
  onCompact?(input: { reason: 'threshold' | 'manual' | 'native'; transcript: ContextView; state: StrategyState; budget: ContextBudget }): Promise<{ state: StrategyState; events: StrategyEvent[] }>;

  /** 钩子 3：策略暴露给模型的工具（例如剪枝策略的 compress / decompress / search_context） */
  tools?(): ReadonlyArray<StrategyTool>;

  /** 钩子 4：状态持久化和重放 */
  initialState(): StrategyState;
  replay(transcript: ContextView): Promise<StrategyState>;   // 没有旁路状态时，从原始记录重建

  /** runtime-plugin 模式：生成要下发给运行时插件的配置（例如 billion-context-pi 的 acp.json） */
  pluginConfig?(target: { runtime: string; pluginVersion: string }): unknown;
}

interface StrategyTool {
  name: string; description: string; inputSchema: unknown;
  call(args: unknown, ctx: { state: StrategyState; transcript: ContextView }): Promise<{ result: unknown; state: StrategyState; events: StrategyEvent[] }>;
}

/** 策略产出的事件：写进会话事件流，提炼（ADR 0019 §6.1）和 UI 都读它 */
type StrategyEvent =
  | { kind: 'compressed'; range: MsgRange; tier: number; summary: string; blockId: string }
  | { kind: 'decompressed'; blockId: string }
  | { kind: 'compacted'; range: MsgRange; summary: string; native: boolean }
  | { kind: 'truncated'; range: MsgRange }
  | { kind: 'nudge'; level: 'soft' | 'hard'; usedRatio: number }
  | { kind: 'principle-candidate'; text: string; scope: 'role' | 'project'; range?: MsgRange; proposedBy: 'agent' | 'strategy' | 'distill' };
```

**不变量**：
- **原始记录不动**：策略只产出视图和旁路状态，hub 的会话记录（`session_events`）永远是完整的原文。
- **状态可重建**：`replay(transcript)` 必须能得到与持久化的状态等价的结果（billion-context-pi 的做法）；持久化的状态只是缓存。
- **每会话恰好一个策略**：`sessions.context_strategy` 记录策略 id 和版本。切换策略要先结束当前一代，或者做一次显式迁移：新策略 `replay` 后生效，审计记一条 `context.strategy.switch`。
- **保护规则**由每个策略自己实现，但 hub 有一条底线：最后一条用户消息、未完成的工具调用 / 结果对（协议要求成对）不能被删除或压缩。

### 3.1 内置策略

| id | 模式 | 做法 | 工具 | 注入 |
|---|---|---|---|---|
| `compaction`（默认） | native（优先）/ hub-managed | 到 `softLimit` 时生成一条摘要替换旧内容，保留最近 K 轮；运行时有原生压缩就用原生的 | 无 | 无 |
| `trim`（候选） | hub-managed | 保留最近 N 轮或 T token，丢弃更早的 | 无 | 无 |
| `tool-clear`（候选） | hub-managed / native（Claude API） | 清理旧的工具结果，保留最近 K 个，`exclude_tools` | 无 | 一句话：「旧工具结果已清理，可以重新执行」 |
| `summarize-window`（候选） | hub-managed | 最近 N 轮原文 + 更早内容的滚动摘要 | 无 | 无 |
| `context-pruning`（候选，暂不做） | runtime-plugin（pi：billion-context-pi；opencode：opencode-acp）/ hub-managed | 主动上下文剪枝：稳定 id、模型决定、可逆、分层 T1→T3、保护区、`search_context`、旁路状态可重放（§2.1） | `compress`、`decompress`、`search_context` | 压缩说明 + 用量提醒 |
| `paging`（候选，MemGPT 式） | hub-managed | 主上下文 + 换出的块，模型用工具换入 | `page_in`、`page_out` | 简短说明 |

### 3.2 原则候选（通用，默认开）

不依赖任何具体策略：任何策略都可以产出 `principle-candidate` 事件（把上面类型里的 `rule-candidate` 改名为它），提炼（ADR 0019 §6.1）也会从会话里抽出同类候选。规则：

- **默认开**：agent 在会话里提出的原则性规则（类似 billion-context-pi 的 `acp_rule`）都会生成候选；
- **只是候选**：进 ADR 0019 的 procedural 确认队列，**人确认后**才成为角色或项目的 procedural 记忆；未确认的候选不影响任何会话（不注入、不生效）；
- 出处按消息 id 范围记录；同一会话每代最多 5 条，超出合并或丢弃，并计入提炼限额。

```ts
// 加在 StrategyEvent 里（替换 rule-candidate）
| { kind: 'principle-candidate'; text: string; scope: 'role' | 'project'; range?: MsgRange; proposedBy: 'agent' | 'strategy' | 'distill' }
```

## 4. 与 RuntimeAdapter 的关系：三种上下文模式

`RuntimeAdapter` 产出的 `PreparedRuntime`（ADR 0013）描述里加一项**能力声明**，不改 `prepare()` 的签名：

```ts
interface ContextCapability {
  modes: ReadonlyArray<'hub-managed' | 'native' | 'runtime-plugin'>;
  /** runtime-plugin：运行时里可以安装哪些策略插件、它们各自的版本 */
  plugins?: ReadonlyArray<{ strategy: string; package: string; versions: string[] }>;
}
```

| 模式 | 谁改上下文 | hub 做什么 | 例子 |
|---|---|---|---|
| **hub-managed** | hub 的 `ContextStrategy.transform`，在每次调用模型前执行 | 跑策略；暴露策略工具；持久化状态 | 运行时把上下文的组装交给 hub：hub 自己调模型的运行时，或者走 hub 的模型代理（类似 billion-context 的代理方式） |
| **native** | 运行时自己（例如 Claude Code `/compact`、自动压缩） | **只观察和记录**：用量、压缩事件、摘要；能触发压缩、重启会话 | Claude Code、Codex CLI 的原生压缩 |
| **runtime-plugin** | 装在运行时里的策略插件 | 安装锁定版本的插件、下发配置（`pluginConfig`）、观察事件；插件状态文件只读 | pi + billion-context-pi；opencode + opencode-acp |

会话选了某个策略后，hub 在启动会话时检查：运行时支持这个策略的某种模式吗？
- 支持：按 hub-managed > runtime-plugin > native 的优先级选一种。
- 不支持：**退回 `compaction`（native）**，会话上标出「策略不受支持，已退回默认」，并审计。

在 runtime-plugin 模式下，「每会话恰好一个策略」要靠 hub 来保证：
- 启动前确认运行时里只装了一个上下文插件；
- 以后在 pi 上装剪枝插件时，确认 pi 原生自动压缩已被插件取消（billion-context-pi 的 README 说会自动取消），否则启动时用 RPC 的 `set_auto_compaction` 关掉。

## 5. 接入等级

### 5.1 定义

| 等级 | 要求 | 内容 |
|---|---|---|
| **L1（必须）** | 每个 RuntimeAdapter 都要做到；「统一接入」= 全部达到 L1 | **观察**：上下文用量（已用 / 窗口）、压缩事件（开始、结束、摘要）、会话记录导出（给提炼用）。**控制**：触发压缩、重启会话（新一代）。**记忆**：通过 hub MCP 工具读写（ADR 0019） |
| **L2（可选，声明了才有）** | `ContextCapability.modes` 里包含 `hub-managed` 或 `runtime-plugin` | hub-managed：每次调用模型前改写上下文；runtime-plugin：在运行时里安装策略插件，hub 下发配置 |
| **L3（不要求）** | 运行时的内部机制、它自己的记忆文件（CLAUDE.md、auto memory、`.acp.json`……） | hub **只读、只索引**（作为 ADR 0019 的来源），不写 |

### 5.2 L1 接口草图

```ts
// 运行时适配器在 L1 必须提供的能力（挂在 AgentRuntime 上，或者由事件映射提供）
interface ContextObservable {
  /** 每轮结束（或运行时上报时）给出用量；拿不到准确值时 estimated = true */
  usage(sessionId: string): Promise<{ usedTokens: number; windowTokens: number; estimated: boolean } | null>;
  /** 订阅压缩事件：原生压缩、插件压缩都映射到这里 */
  onCompaction(listener: (e: { sessionId: string; phase: 'start' | 'end'; trigger: 'auto' | 'manual'; summary?: string; range?: MsgRange }) => void): () => void;
  /** 导出会话记录（统一格式，带 hub 的稳定消息 id），给提炼和审计用 */
  exportTranscript(sessionId: string, since?: MsgId): AsyncIterable<TranscriptItem>;
}

interface ContextControllable {
  /** 触发一次压缩；运行时不支持时返回 'unsupported'，由 hub 退回「重启 + 注入上一代摘要 id」 */
  compact(sessionId: string, focus?: string): Promise<'ok' | 'unsupported'>;
  /** 结束当前一代，开新一代（持久型会话的「重启」） */
  restart(sessionId: string): Promise<void>;
}

// L1 = ContextObservable & ContextControllable & 「会话里接入了 hub MCP 服务器 agent-hub」
```

现有的 hub 会话事件流已经记录了每条消息（`session_events`），所以 `exportTranscript` 大多数情况可以由 hub 自己完成，不需要运行时导出；只有运行时在 hub 看不到的地方改写了历史（原生压缩）时，才需要运行时的压缩事件来标出范围。

### 5.3 矩阵：现有运行时 + Claude Code、Codex CLI、pi、opencode

agent-hub 现在内置的适配器（`packages/adapters/`）：
- `pi`（`pi --mode rpc`）；
- `grok`（`grok --no-auto-update agent stdio`）；
- `acp`（Agent Client Protocol 协议，默认条目只有 `opencode acp`，可以配置更多 ACP agent）。

Claude Code、Codex CLI 目前**没有**内置适配器，下表按它们公开的接口评估。

| 运行时 | L1 能做到吗、怎么做 | L2 能到哪种模式、怎么做 | L3 | 来源 | 核对 |
|---|---|---|---|---|---|
| **pi**（已支持） | ✓ RPC：`get_session_stats`（用量）、`compaction_start / compaction_end` 事件、`compact` 命令、`set_auto_compaction`；扩展事件 `session_before_compact / session_compact` | **runtime-plugin ✓**：扩展 API 有 `context` 事件（每次调用模型前），billion-context-pi 就是用它实现的；也可以做 hub-managed（hub 写一个 pi 扩展，把 `context` 事件转给 hub 策略） | `~/.pi/agent/sessions/*.jsonl` 和 `.acp.json` 只读 | [pi RPC](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/rpc.md) · [pi extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) · [billion-context-pi](https://pi.dev/packages/billion-context-pi) | 已核对（看到命令和事件名，参数没逐个核对） |
| **opencode**（已支持，走 ACP 协议） | 部分：ACP 的 `usage_update`（会话用量）还是 **RFD 阶段**；压缩事件 ACP 没有标准消息 → 用 opencode 插件的 `session.compacted` 事件 | **runtime-plugin ✓**：opencode 插件有 `experimental.session.compacting` 钩子；opencode-acp 是 ACP 策略的现成插件。hub-managed：没找到「每次调用模型前改写消息」的公开钩子 → **未核对** | 只读 | [ACP session usage RFD](https://agentclientprotocol.com/rfds/session-usage) · [opencode plugins](https://opencode.ai/docs/plugins/) · billion-context-pi README 里的 opencode-acp | 已核对（hub-managed 部分未核对） |
| **grok**（已支持） | 用量、压缩事件、触发压缩：**未核对**（`grok agent stdio` 的协议细节没有找到公开文档） | 未知 | 未知 | — | **未核对** |
| **Claude Code**（未支持） | ✓ hooks `PreCompact` / `PostCompact`（带 `compact_summary`）、`SessionStart`，hook 输入里有 `transcript_path`；`/compact [focus]` 手动压缩；用量从流式输出拿 → **headless 模式下怎么触发 `/compact` 未核对** | **native**；hub-managed 只能走模型代理（改 base URL，billion-context 的代理方式说明可行，但对 Claude Code **未核对**）；没有每次调用模型前改写消息的插件钩子 | CLAUDE.md、auto memory 只读（ADR 0019） | [hooks](https://code.claude.com/docs/en/hooks) · [how Claude Code works](https://code.claude.com/docs/en/how-claude-code-works) · [memory](https://code.claude.com/docs/en/memory) | 已核对（headless `/compact`、代理未核对） |
| **Codex CLI**（未支持） | ✓ hooks `PreCompact` / `PostCompact` / `SessionStart` / `Stop`，有 `transcript_path`；配置 `model_auto_compact_token_limit`、`compact_prompt`；用量和手动压缩的程序化接口**未核对** | **native**（可以通过 `compact_prompt` 定制摘要）；hub-managed 只能走模型代理 → **未核对** | 只读 | [Codex hooks](https://developers.openai.com/codex/hooks) · [config reference](https://developers.openai.com/codex/config-reference) | 已核对（程序化压缩、代理未核对） |

由此得出：
- **pi 是第一个能同时做到 L1 和 L2（runtime-plugin）的运行时**；以后做 `context-pruning` 时首选 pi。
- opencode 的 L1 依赖 ACP 协议的 `usage_update`（RFD）和 opencode 插件，**适配器要做一个 opencode 插件来补 L1**。
- grok 要先查清协议才能定级；在此之前按「L1 缺口」处理：hub 用自己的事件流估算用量，「触发压缩」退回为「重启会话」。
- Claude Code、Codex 以后做适配器时，L1 用 hooks 就能做到，L2 先不做。

## 6. 注入的引导文字放在哪里（与「记忆只用工具读」的关系）

ADR 0019 决定：记忆**只用工具读、不注入**。策略的引导文字不违反这条，理由与限制如下：
- **它是政策，不是记忆**：内容来自管理员安装的策略版本（例如压缩说明模板），不是任何 agent、用户或外部写的条目，所以是 trusted。
- **禁止夹带记忆**：`guidance` 里不能出现记忆条目、用户偏好、角色或项目的内容；hub 校验 `guidance` 只来自策略包里的静态模板，加上用量数字等少量变量。
- **长度上限**：压缩指南 ≤ 1.5k token；用量提醒每条 ≤ 200 token，接近上限时才发。
- **可见、可审计**：会话详情里能看到「策略注入」这一项；版本变化记审计。
- **记忆引导一行（David 2026-10-31）**：所有策略（包括默认的 `compaction`）都带一条 hub 级固定引导：「你可以用 memory_search / memory_get 查本项目和本角色的记忆；开始工作前先搜索相关约定。」它只告诉 agent 有记忆工具、应该先查，**不含任何记忆条目**，≤ 80 token，见 `memory.md` §7.2。native 模式下改用运行时的系统提示词追加或说明文件机制，做不到就只靠工具描述，UI 标出缺口。
- **位置**：hub-managed 模式下由 hub 加到系统提示词末尾；runtime-plugin 模式下由插件自己注入（例如 billion-context-pi）；native 模式下，策略自己的引导不注入，只有上面那行记忆引导会尽量通过运行时的机制加进去。

## 7. 提炼怎么用策略产出（接 ADR 0019 §6.1）

- 提炼的输入加上策略事件：`compressed` / `compacted` 的摘要和 `rule-candidate`。
- **出处按消息 id 范围记录**：`SourceRef.uri = session://<sid>/msgs/<from>..<to>`；压缩块还记 `blockId` 和 `tier`。这样即使原文已经被压缩出视图，条目也能追溯到原始记录（原始记录不动）。
- `principle-candidate`（§3.2，默认开）→ 作为 procedural 候选，**一律进人工确认队列**（ADR 0019 已决）。
- 提炼的时机：任务型会话结束时；持久型会话每次 `compacted` / 一批 `compressed` 之后（已决：提炼默认开，限额见 ADR 0019 §6.1）。

## 8. 配置、权限、审计、版本

- **选择**：`context.strategy` 可以设在 hub 默认、项目、角色、会话（会话 > 角色 > 项目 > hub）。参数（阈值、保护工具、K、N……）跟着策略一起设置，经 zod schema 校验。
- **权限**（加进 ADR 0017 的矩阵）：

| 权限点 | 说明 |
|---|---|
| `context.strategy.install` | 安装或升级策略版本（含运行时插件）：**只有 `cluster_admin`**（本机 Worker 上装插件属于 `runtime.*`，ADR 0017 已规定归集群管理员） |
| `context.strategy.set` | 项目、角色上选策略：owner / admin |
| `session.context.set` | 单个会话上选策略：会话创建者（`own`），只能从已启用的策略里选 |
| `session.context.compact` | 手动触发压缩 / 重启：和 `session.prompt` 相同 |

- **审计**：安装、升级、切换策略、退回默认、手动压缩、紧急截断都记审计；每次 `transform` 只记计数和 token 前后变化，不记内容。
- **版本**：
  - 管理员装的是**锁定版本**（npm 包锁到确切版本 + 完整性哈希），**不自动更新**；
  - pi 插件用 `pi install npm:<pkg>@<version>` 装到 hub 管理的目录，不碰用户自己的 `~/.pi`（复用 ADR 0013 的资产 / 安装器路径）；
  - billion-context-pi 有自动更新逻辑（README 里提到 update failures），安装时必须在配置里关掉，具体键名**未核对**；
  - 升级走「新版本对新会话生效，现有会话保持旧版本直到下一代」。

## 9. 分期

| 期 | 内容 |
|---|---|
| **P1** | `ContextStrategy` 端口、`compaction` 内置策略（native）；所有已支持的适配器补齐 **L1**（pi 用 RPC；opencode 用 ACP + 插件；grok 先查协议，查不到就用估算 + 重启兜底）；会话级用量和压缩事件在 UI 显示；策略选择和权限 |
| **P2** | 压缩事件和摘要接入提炼（与 ADR 0019 P2 的提炼同时上线）；`principle-candidate` 进确认队列（默认开） |
| **P3** | hub-managed 模式：以 pi 扩展（`context` 事件转发给 hub）为第一个载体；`trim`、`tool-clear`、`summarize-window` 候选策略 |
| **P4** | 模型代理方式的 hub-managed（给没有插件钩子的运行时用）、`paging` 策略；Claude Code / Codex 适配器（L1 用 hooks） |
| **候选（不排期）** | 主动上下文剪枝 `context-pruning`（参考 §2.1 的 billion-context-pi 调研） |

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 两个策略同时改上下文（例如剪枝插件 + 原生压缩） | 每会话一个策略；启动前检查插件，关掉原生自动压缩；冲突时退回默认并审计 |
| 第三方插件（billion-context-pi）行为变化、自动更新 | 锁版本 + 哈希；关自动更新；管理员升级 |
| README 的效果宣称没有独立验证 | P2 在 pi 上做 A/B：同一类任务对比 token 和完成率 |
| 运行时的 L1 接口不全（grok、ACP 协议的 usage 还是 RFD） | 用 hub 事件流估算；「触发压缩」退回「重启」；矩阵里标出缺口 |
| 注入的策略引导被用来夹带记忆或指令 | 只允许静态模板 + 数字变量；hub 校验；审计 |
| 原生压缩改写历史，hub 的记录和运行时的记录对不上 | hub 的原始记录不动；用压缩事件记录范围和摘要 |

## 11. 决定（David，2026-10-31，全部已决）

1. **端口划分**：`ContextStrategy` 和 `MemoryService` 分开，策略产出作为提炼的输入。
2. **hub 默认策略**：`compaction`；运行时有原生压缩就用原生的。
3. **选择层级**：会话 > 角色 > 项目 > hub；会话级只能从项目已启用的策略里选。
4. **主动上下文剪枝**：**先不做**（「acp上下文先不做」）。从内置策略和分期里移除，只作为候选适配器 `context-pruning` 保留，§2.1 的 billion-context-pi 调研作参考。
5. **策略注入**：允许，限于策略包里的静态模板 + 用量数字，有上限、要审计。
6. **原则候选**：agent 提出的原则性规则**默认开**，产出 procedural 候选，必须人工确认；不绑定具体策略，在策略 / 提炼接口里通用定义（§3.2）。
7. **L1 有缺口的运行时**：允许接入，用估算用量和「重启」兜底，UI 上标出缺口。
8. **版本**：只有 cluster_admin 能安装策略，锁版本，不自动更新，新版本只对新会话生效。

实施顺序（David 2026-10-31 同意）：消息 P2P 核心 → 记忆 P1 → IM / 群聊 → 上下文策略和运行时套件。

### 11.1 未决

无。
