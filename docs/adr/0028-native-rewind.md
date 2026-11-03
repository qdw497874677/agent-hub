# ADR 0028：「从这里重来」优先用运行时原生分叉 / 回退

- 状态：proposed（草案，等 David 定 Q1–Q7）
- 相关：ADR 0006（提示词是 journal 事件）、ADR 0012（fork 血缘）、ADR 0013 D8（统一运行时适配器契约）、ADR 0027（D8 无原生 rewind 时分叉、D9 文件回滚只限临时工作空间、阶段 4 / PR #182 的现有实现）
- 调研日期：2026-11-02（各文档 / 源码取当日 main）

## 背景

ADR 0027 D8 写的是「支持 rewind 的 runtime 调原生接口，不支持的才分叉」，但阶段 4（PR #182，`packages/domain/src/use-cases/rewind.ts`）上线时所有运行时一律走兜底：新开一条 agent 会话（`resume = null`），把之前的对话压成交接摘要发过去。代价：

1. 摘要有损：工具调用细节、读过的文件、推理过程都丢了，新 agent 要重新摸一遍代码。
2. 多花一轮模型调用（摘要作为 briefing 发送），而且 prompt cache 全部失效。
3. agent 自己的会话列表（`pi /resume`、`claude --resume`）里看不到这次分叉的来龙去脉。

而 pi、Claude Code、Codex、OpenCode 现在都有「从某条消息分叉出新会话、上下文逐字保留」的原生能力。本 ADR 把它接进来，摘要交接留作兜底。

## 调研：各运行时的原生能力

hub 现在接入的方式（`apps/worker/src/runtimes.ts`）：pi（`pi --mode rpc` 子进程，`packages/adapters/pi`）、ACP 通用适配器（默认 OpenCode `opencode acp`；Claude Code / Codex 要在 `ACP_AGENTS` 里配 `claude-agent-acp` / `codex-acp`）、Grok（`grok agent stdio`，ACP）、Hermes（Runs API）。所以「能不能用」= 运行时本身有没有 × hub 接它的那条协议有没有暴露出来。

| 运行时 | 原生能力 | 按哪条消息分叉 | 原地回退（同一会话） | 文件一起回退 | hub 这条通道能不能用 | 来源 |
|---|---|---|---|---|---|---|
| **pi** | 会话是 id/parentId 的树（`/tree` 原地切分支，`/fork` 新会话）。RPC：`get_fork_messages` 列出可分叉的用户消息（`entryId`），`fork {entryId}` 从这条用户消息**之前**新建会话文件并返回原消息文本；`get_tree` / `get_entries` 读树；`clone` 整段复制 | ✅ `entryId`（用户消息） | 只有 TUI 的 `/tree`（会生成 `branch_summary`），RPC 没有原地切叶子的命令 | ❌ 不管文件 | ✅ 已经在跑 RPC，直接发 `fork` | [rpc-commands.md#fork](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md#fork)、[session-format.md（Tree Structure / BranchSummaryEntry）](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md) |
| **Claude Code** | `/rewind`（Esc Esc）：恢复对话 / 恢复代码 / 两者都恢复；`/branch`、`--resume <id> --fork-session`。Agent SDK：`forkSession(sessionId, {upToMessageId})` 复制到某条消息（含）为新会话；`resume` + `resumeSessionAt: <uuid>` 截断式恢复；`rewindFiles(uuid)` 回退文件 | ✅ 用户消息 `uuid` | ✅ `resumeSessionAt`（SDK / print 模式） | ⚠️ 有，但只覆盖 Write/Edit/NotebookEdit 改过的文件，**bash 改的、子代理改的、目录增删都不回退**；分叉出来的新会话**不带**原会话的文件检查点；快照约 30 天清理 | ⚠️ 走 `claude-agent-acp`：它实现了 ACP 不稳定方法 `session/fork`（`src/fork-session.ts`，按 `_meta.jetbrains.air.fork.messageId` 指定消息） | [checkpointing](https://code.claude.com/docs/en/checkpointing)、[Agent SDK TS：forkSession / resumeSessionAt](https://code.claude.com/docs/en/agent-sdk/typescript)、[file-checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)、[CLI --fork-session](https://code.claude.com/docs/en/cli-reference)、[claude-agent-acp fork-session.ts](https://github.com/zed-industries/claude-agent-acp/blob/main/src/fork-session.ts) |
| **Codex CLI** | app-server：`thread/fork {threadId, beforeTurnId | lastTurnId}` 新线程；`thread/revert {threadId, beforeTurnId}` 原地丢掉这一轮及之后（旧的 `thread/rollback` 已删除）；TUI 有 Esc 回溯 | ✅ `turnId` | ✅ `thread/revert` | ❌ 只动对话历史，不动文件 | ⚠️ hub 走 `codex-acp`，要看它的 `initialize` 有没有声明 `sessionCapabilities.fork`；没有就兜底（不为 Codex 单独写 app-server 适配器，见 Q4） | [app-server-protocol v2/thread.rs（ThreadForkParams / ThreadRevertParams）](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)、[app-server README「Thread rollback」](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) |
| **OpenCode** | HTTP server：`POST /session/:id/fork {messageID?}` 在某条消息处分叉；`POST /session/:id/revert {messageID, partID?}` 原地回退、`/unrevert` 撤销；TUI `/undo` `/redo` | ✅ `messageID` | ✅ `revert` / `unrevert` | ⚠️ `revert` **会**用它自己的 git 快照把文件也退回（要求是 git 仓库） | ⚠️ hub 走 `opencode acp`：同样看 `initialize` 是否声明 `session/fork`；不走它的 HTTP server（多开一个端口、另一套鉴权） | [opencode server docs](https://opencode.ai/docs/server/)、[TUI /undo /redo](https://opencode.ai/docs/tui/) |
| **Grok** | ACP `sessionCapabilities` 只有 list/resume/close；headless `--fork-session` 只能整段复制（见 `packages/adapters/grok/src/descriptor.ts`） | ❌ | ❌ | ❌ | ❌ 兜底 | 现有 descriptor 注释 |
| **Hermes** | Runs API 有整段 session fork，不能指定消息（见 `packages/adapters/hermes/src/descriptor.ts`） | ❌ | ❌ | ❌ | ❌ 兜底 | 现有 descriptor 注释 |

ACP 层面：`session/fork` 目前是 RFD 阶段的不稳定方法（[Forking of existing sessions](https://agentclientprotocol.com/rfds/session-fork)），协议本身**没有**「从哪条消息」的标准字段，claude-agent-acp 用 `_meta` 扩展实现。所以 ACP 适配器要按 agent 区分「整段 fork」和「按消息 fork」，不能只看有没有 `session/fork`。

**结论**：能可靠「按消息分叉、上下文逐字保留」的：pi（现在就能做）、Claude Code（经 claude-agent-acp，需要版本探测）。Codex / OpenCode 运行时本身支持，但取决于 ACP 桥有没有暴露，按能力探测，没有就兜底。Grok / Hermes 兜底。**没有一家的文件回退比 hub 自己的 git checkpoint（ADR 0027 D1）更完整**——都漏掉 bash 改动或依赖各自快照。

## 决定（草案）

### 1. 端口：运行时声明「分叉」能力，hub 统一编排

不在 `RuntimeSession` 上做「原地回退」，而是**分叉时由新会话启动参数带上锚点**，原 hub 会话和原 agent 会话都不改（与 ADR 0006/0012「只追加不删」一致，见 Q1）。

```ts
// packages/domain/src/ports/agent-runtime.ts
export interface StartSpec {
  // …现有字段
  /** 从来源 agent 会话的某条用户消息之前分叉（ADR 0028）。运行时没声明 branch 能力时 hub 不会给。 */
  readonly branch?: { readonly fromAgentSessionRef: string; readonly beforeTurnRef: string } | null;
}

// agent.ts 的能力矩阵：fork 现在是 limited（只能从最新处），新增一项
//   branch_at_turn: available | limited(原因) | denied(原因)
// 运行时在 start() 里做：pi = 带 --session-id 来源 → RPC fork{entryId}；ACP = session/fork（+ agent 方言的 _meta 锚点）。
// 成功后照旧走 ctx.onAgentSessionRef(新会话 id) 报给 hub。

// 锚点：每轮开始时运行时报一次本轮用户消息在 agent 侧的 id
export interface RuntimeAdapterContext {
  // …现有字段
  onTurnRef?(sessionId: string, promptSeq: number, turnRef: string): void;
}
```

- **锚点记录**：新表或沿用 `turn_checkpoints` 加一列 `agent_turn_ref`（pi `entryId`、Claude 用户消息 `uuid`、Codex `turnId`、OpenCode `messageID`）。pi 在 `prompt` 后用 `get_entries {since}` 取新用户消息的 id；ACP 从 `session/prompt` 响应 / 回放的 `_meta` 里取（各 agent 方言放在 `acp/src/config.ts` 的配置里，「是配置不是代码」）。
- **用例**（`use-cases/rewind.ts`）：`native = descriptor.branch_at_turn === available && 来源有 agentSessionRef && 这条消息有 turnRef && 新会话落在同一台 Worker`。是 → `startCommand(..., branch)`，**不再发摘要 briefing**；否 → 现有摘要兜底。原生分叉启动失败 → 自动退回摘要兜底，并在新会话里记一条 diagnostic（见 Q5）。
- **工作日志 / 血缘**：hub 侧仍然是 `forkSession({atSeq: promptSeq - 1})`，新会话事件里多一个 `branchMode: 'native' | 'summary'`，界面和审计都能看到用的是哪种。

### 2. 文件回滚只认 hub 的 git checkpoint（D9 不变）

「连文件一起回滚」继续只用 ADR 0027 的 `refs/agent-hub/checkpoints/…` 恢复，仍只限临时 git 工作空间、仍先拍安全快照。**不调** Claude `rewindFiles`、**不调** OpenCode `revert`（它们只覆盖部分改动，且和 hub checkpoint 同时动文件会互相打架）。分叉一律用「新会话」类方法（pi `fork`、`session/fork`、Codex `thread/fork`），不用会顺手改文件的原地 revert。

### 3. 界面

对话框结构不变（还是「只回滚对话 / 连文件一起回滚」两个单选），只在上方加一行「怎么接上之前的对话」：

- 原生：「✓ 用 Pi 自带的分支：新会话逐字保留这条消息之前的上下文（不用摘要）」
- 兜底：「新会话会收到一段之前对话的摘要（Grok 不支持从中间分叉）」——原因由能力矩阵的 `limited/denied` 文案给出。
- 文件选项文案、灰掉规则、原因提示都沿用阶段 4。
- 手机 390 宽：同一卡片全宽底部弹出，说明文字换行不截断。

示意图：`/workspace/shots/native-rewind/`（desktop-1280-native.png、desktop-1280-fallback.png、mobile-390-native.png、mobile-390-fallback.png）。

## 待定问题（附推荐）

- **Q1 原地回退还是新会话？** A. 一律新 hub 会话 + agent 原生分叉（**推荐**：不改原会话，和现有血缘、审计、并发规则一致；Claude/Codex/OpenCode 的原地回退会和 hub 已展示的历史对不上）；B. 支持原地回退的运行时原地回退，hub 把后面的消息标成 rewound。
- **Q2 文件回退用谁的？** A. 只用 hub checkpoint，D9 不变（**推荐**）；B. 长期工作空间里允许用 Claude `rewindFiles` 做「只撤 agent 自己 Edit 过的文件」（覆盖不全、可能撤掉别的会话的改动）。
- **Q3 老消息没有 turnRef（本 ADR 上线前的对话）**：A. 自动走摘要兜底并在对话框说明（**推荐**）；B. 上线时尝试按文本回填匹配 pi `get_fork_messages` / Claude `getSessionMessages`（有重复文本时会错）。
- **Q4 Codex 怎么接？** A. 只在 `codex-acp` 声明了按消息 fork 时用，否则兜底，不新写适配器（**推荐**）；B. 新写一个 Codex app-server 适配器，直接用 `thread/fork {beforeTurnId}`（工作量大，等真有人在用 Codex worker 再说）。OpenCode 同理，不接它的 HTTP server。
- **Q5 原生分叉失败（agent 会话文件被清理、版本太旧、跨 Worker）**：A. 自动退回摘要，新会话里提示一行（**推荐**）；B. 报错让用户选。
- **Q6 跨 Worker / 换 agent 的重来**：agent 会话文件在原机器上，A. 只要换机器或换 agent 就用摘要（**推荐**）；B. 尝试把会话文件拷过去（pi 的 jsonl 可以，Claude 有 `importSessionToStore`，但路径、凭据都牵扯，不值）。
- **Q7 pi 的原地 `/tree` 要不要接？** pi RPC 目前没有切叶子的命令，只能 `fork`。A. 只用 `fork`（**推荐**）；B. 等 pi RPC 加 navigate 再说。

## 实施（定稿后）

1. 端口 + 能力项 `branch_at_turn` + `onTurnRef` + 存储列；能力矩阵 conformance 测试。
2. pi：记录 entryId、`start` 支持 `branch`（`--session-id` 来源 → `fork`）；fake pi 单测 + 真 pi e2e。
3. ACP：initialize 探测 `session/fork`，方言配置（claude-agent-acp 的 `_meta` 锚点），记录 turnRef；OpenCode / Codex 按探测结果开关。
4. 用例 + 对话框文案 + e2e（原生 / 兜底 / 原生失败退回三条），线上用测试账号走 pi 一遍。
