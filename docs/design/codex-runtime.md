# Codex 运行时（codex app-server）

状态：实施中（2026-11-14）
目标：把 OpenAI Codex CLI 接成 agent-hub 的第 5 个运行时（`pi` / `opencode` / `grok` / `hermes` 之后），复用现有会话、事件、可调项、审批、MCP 与模型提供商通道，**不改内核**。

## 1. 结论与取舍

| 通道 | 结论 |
| --- | --- |
| `codex app-server`（JSON-RPC 2.0 over stdio） | **采用**。唯一同时具备流式 delta、交互审批、`thread/resume` 续跑与按 thread 注入 MCP 的通道 |
| `codex exec --json` | 不用。无 token 级 delta、无审批通道（只有 `--approve-for-me` / 完全绕过），只适合一次性任务 |
| ACP 桥（`@agentclientprotocol/codex-acp`） | 不用。多一层 Node 依赖、丢 Codex 特有事件（plan/diff/usage），且与桥版本强耦合 |

代价：`app-server` 官方标注 experimental / internal，方法名可能变。缓解办法：锁定 codex 版本（本机 mise 升到 0.168.0），协议 schema 随版本导出并入库做快照测试（见 §8）。

## 2. 跑在哪台机器

选中 `omarchy`（本地 worker）：codex 已装、可直接对着 `codex app-server` 调试；凭据（`OPENAI_API_KEY`）只落本机 `~/.config/agent-hub/worker.env`，不进仓库、不进 hub。
阿里云 worker 不装 codex：它的用途是「远端机器」，没有本机凭据也没必要付双份流量。以后要装，只需在那台机器 `mise use -g codex@0.168.0` 并在 worker.env 里加 key。

## 3. 启动

```
codex app-server            # 默认 --listen stdio://
```

- 工作目录：会话 workspace root（`StartSpec.workspaceRoot`）。
- 环境：继承 worker env（`OPENAI_API_KEY` 从这里进）；额外设 `CODEX_HOME`（默认 `~/.codex`，可由 `CODEX_HOME` 覆盖）。
- 不用 `--ws`、不用 daemon：每会话一个进程，`dispose()` 时先 `turn/interrupt`（若在跑）再 SIGTERM→3s→SIGKILL，按进程组杀。
- 握手：`initialize {clientInfo:{name:"agent-hub",version:<pkg version>}, capabilities:{}}` → 收到结果后发 `initialized` 通知。

## 4. 协议映射

方法名与参数以 0.168.0 导出的 schema 为准（`codex app-server generate-json-schema --out <dir>`；本机一份在 `/tmp/opencode/codex-test/schema168/`）。

| 平台动作 | Codex 调用 |
| --- | --- |
| 新建会话 | `thread/start {cwd, model?, config?, developerInstructions?, approvalPolicy?, sandbox?, ephemeral:false}` → `{thread:{id}}`，把 `id` 报成 `agentSessionRef` |
| 续跑 | `thread/resume {threadId}`（该 thread 已有历史，不再重放） |
| 发一轮 | `turn/start {threadId, input:[{type:"text",text}]}`；附件不支持的返回 `invalid` |
| 打断 | `turn/interrupt {threadId, turnId?}` |
| 模型清单 | `model/list`（或读 `config/read`）；失败时退回静态清单 |
| 审批回应 | 对 server→client request 回 `{decision:"accept"｜"acceptForSession"}` 或 `{decision:"decline"}`（枚举以 schema 为准） |

### 4.1 事件 → `SessionEvent`

| Codex 通知 | 平台事件 |
| --- | --- |
| `item/agentMessage/delta {delta}` | `{kind:'text', delta}` |
| `item/reasoning/textDelta`、`item/reasoning/summaryTextDelta` | `{kind:'thinking', delta}` |
| `item/started` / `item/completed`，`item.type==='commandExecution'` | `tool_call`（name=`command`，input=命令行）/ `tool_result`（ok=`exitCode===0`，结果取 `aggregatedOutput` 截尾） |
| `item/*`，`item.type==='fileChange'` | `tool_call`（name=`apply_patch`）+ 成功时 `artifact`（路径取 changes[].path） |
| `item.type==='mcpToolCall'` | `tool_call`（name=`<server>/<tool>`）/ `tool_result` |
| `item.type==='webSearch'` | `tool_call`（name=`web_search`，input=query） |
| `item/plan/delta`、`turn/plan/updated` | 忽略（v1） |
| `turn/completed {turn:{status,error?}}` | `ended`：`completed`→`done`、`interrupted`→`stopped`、`failed`→`failed`（带 `error.message`） |
| `thread/tokenUsage/updated` | `context_usage`（有则发） |
| `error` | `diagnostic {level:'error'}`；若在 turn 中另发 `ended failed` |

注意：同一轮里 `item/completed` 与 `turn/completed` 都会到，**`ended` 只在 `turn/completed` 发一次**。

### 4.2 审批

server→client 的 request：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`mcpServer/elicitation/request`，以及旧版兼容的 `execCommandApproval` / `applyPatchApproval`。

- 一律走 `createApprovalGate`（`packages/domain/src/approval.ts`）：`push` 发 `approval` 事件，`send` 把 `accept`/`decline` 回给 Codex。
- 卡片标题用 `reason`（没有就「Codex 要执行命令」/「Codex 要改文件」），detail 放命令行或文件清单（截尾 2KB）。
- `item/tool/requestUserInput`、`attestation/generate` 在 v1 直接 `decline`（回 `{decision:'decline'}`），并记一条 `diagnostic`。

### 4.3 可调项（options）

| id | label | 取值 | 生效方式 |
| --- | --- | --- | --- |
| `model` | 模型 | `model/list` 返回的 id | 下一轮 `turn/start.model`；同时改 descriptor.models |
| `effort` | 思考强度 | `minimal`/`low`/`medium`/`high`（模型不支持时按 schema 报错降级为不设置） | 下一轮 `turn/start.effort` |
| `approval` | 审批 | `on-request`/`untrusted`/`never` | 下一轮 `turn/start.approvalPolicy` |
| `sandbox` | 沙箱 | `read-only`/`workspace-write`/`danger-full-access` | 下一轮 `turn/start.sandboxPolicy` |

默认：`approval='on-request'`、`sandbox='workspace-write'`、`effort` 不设（用 Codex 默认）。**不默认 `danger-full-access`**。
`changeOption` 返回全量清单；非法值 `invalid('effort 只能是 minimal / low / medium / high')` 这类文案。

### 4.4 MCP / 资产

- `StartSpec.mcp` 映射成 `thread/start.config.mcp_servers`：
  - stdio：`{command, args, env:{...}}`（env 就是 `McpLaunch.env`，已展开的密钥，只进这个进程）；
  - http：`{url, http_headers:{Authorization:"Bearer <tools.token>"}}`（用 `StartSpec.tools.token`）。
- `StartSpec.assets.instructions` 拼进 `developerInstructions`；技能索引同 Grok 的写法（名字 + 描述 + SKILL.md 绝对路径）。

### 4.5 hub 模型提供商（ADR 0013）

v1 **不支持**：`provider` 非空时返回 `invalid('Codex 暂时不支持 hub 模型提供商，请用 opencode / pi')`，避免把中继地址拼错后 401 报得像代码 bug。后续按 Codex 的 `model_providers` 配置接入。

## 5. 就绪与提示

- `ready`：`codex --version` 成功且 `OPENAI_API_KEY` 或 `~/.codex/auth.json` 至少有一个；否则 `unavailable`，reason 分别是「没装 codex（mise use -g codex@0.168.0）」/「还没登录：在 worker 的 env 里给 OPENAI_API_KEY，或跑 codex login」。
- `hint`：命令缺失时的修复话术，同上。
- `installer`：不提供（mise / npm 全局装都行，别让 hub 猜包名）。
- `selfCheck`：不实现（一次真实调用要花钱，`codex doctor` 已够）。

## 6. 失败面

| 情况 | 处理 |
| --- | --- |
| 进程起不来 | `start()` 返回 `unavailable`，错误含 stderr 前 2KB |
| 已登录但 401 | `turn/completed failed`，把 Codex 的 message 原样带进 `ended.reason` |
| thread 丢失（resume 失败） | 报 `invalid('这条会话在 Codex 里已经不存在了，换个新会话吧')`，不静默新开 |
| 进程崩 | 发 `ended failed`「codex 进程退出了（code N）」并清理 |

## 7. 文件与接线

```
packages/adapters/codex/src/
  index.ts           导出 codexAdapter
  adapter.ts         RuntimeAdapter：command('codex','CODEX_COMMAND')、readiness、descriptor
  descriptor.ts      id 'codex'、label 'Codex'、capabilities
  codex-runtime.ts   JSON-RPC over stdio + RuntimeSession 实现（含审批 gate、超时、进程清理）
  jsonrpc.ts         最小 JSON-RPC 客户端（请求 id、超时、通知分发、server→client request）
  map-event.ts       通知 → SessionEvent（纯函数，可单测）
  discover-models.ts model/list（失败退回静态清单）
  readiness.ts       version + 凭据探测
```

接线：`apps/worker/src/runtimes.ts` 的 `RUNTIME_ADAPTERS` 加 `codexAdapter()`；`packages/adapters/codex/package.json` 名 `@agent-hub/adapter-codex`，依赖仅 `@agent-hub/domain`；根 `package.json` 的 workspaces 已覆盖 `packages/adapters/*`，`npm install` 后锁文件会加 16→17 条，`npm run check` 的 lockfile 门禁会验证。

## 8. 测试

1. `jsonrpc.test.ts`：请求/响应配对、超时、通知、server→client request。
2. `map-event.test.ts`：golden fixtures（`agentMessage/delta`、`commandExecution` 生命周期、`fileChange`、`turn/completed` 三态、`error`）。
3. `codex-runtime.test.ts`：用 `test-fixtures/fake-app-server.mjs`（读 stdin 的 JSON-RPC、按脚本应答）跑：握手 → thread/start → 一轮对话 → 审批（accept/decline）→ interrupt → dispose 杀干净。
4. `conformance.test.ts`：喂同一批事件，断言不出现未知事件、`ended` 只一次、`artifact` 路径正确。
5. 真实联调（需 key）：新建会话 → 让它 `echo hi` → 看 text/工具卡/结束；续跑同一会话。
6. schema 快照：`scripts/codex-schema.mjs`（可选，v1 只把 0.168 的关键方法名写进测试断言，升级时失败提醒）。

## 9. 分期

- **C1**（本次）：适配器 + 注册 + 单测 + 假 server 端到端。
- **C2**：真实 key 联调，补 `model/list` 动态清单与 `effort` 支持探测。
- **C3**：hub 模型提供商（`model_providers`）与 `codex mcp` 之外的技能目录约定。
- 不做：`thread/fork` 原生分叉（我们的 fork 已由 hub 摘要交接兜底）、`review/*`、realtime 语音。

## 实现进展（2026-11-14）

- 包：`packages/adapters/codex/`（`codexAdapter`、`codexDescriptorFor`、`createCodexRuntime`、`JsonRpcPeer`、`createCodexEventMapper`、`discoverModels`、`codexReadiness`），注册在 `apps/worker/src/runtimes.ts` 的 `RUNTIME_ADAPTERS`。
- 测试：golden 事件映射 17 条、conformance 4 条、端到端 7 条（`test-fixtures/fake-app-server.mjs` 真子进程，含审批 allow/decline、interrupt、dispose 挂审批、resume 失败、非法 option、provider 拒绝），共 34 条。
- 与设计稿的偏离（按 0.168.0 schema）：`turn/interrupt` 必带 `turnId`；`item/permissions/requestApproval` 的应答是 `{permissions, scope}`，不是 `accept/decline`；旧版 `execCommandApproval`/`applyPatchApproval` 用 `approved` / `{denied:{rejection}}`；`fileChange` 审批不带文件清单（detail 缺省）；`item/tool/requestUserInput` 回 `{answers:{}}`、`item/tool/call` 回 -32601 并记 diagnostic；`spec.branch`（分叉）返回 `invalid`；`effort` 只有显式设置时才下发。
- 需要配置：worker env 里 `OPENAI_API_KEY`（或不配，用 `codex login` 生成 `~/.codex/auth.json`）；机器上要有 `codex` 可执行文件（本机用 mise 装 0.168.0）。
- 限制：v1 不支持 hub 模型提供商（`provider` 返回 `invalid`）、不支持分叉。
