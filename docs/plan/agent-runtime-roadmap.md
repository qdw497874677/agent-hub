# Agent Runtime 演进工作台

> 状态：执行中 · 2026-11-11
> 目标：把 Paseo 中经过验证的 agent 适配、可调项、子代理、权限与运行时管理能力，按 Hub 的会话模型分阶段落地。
> 关联：ADR 0007、ADR 0018、ADR 0023、ADR 0030、ADR 0034、`docs/design/runtime-adapter-contract.md`

## 0. 命名与边界

- **Agent Runtime**：Claude Code、OpenCode、Pi、Grok 这类 agent CLI 适配器。Hub 现有的 `provider` 只指模型 API 提供商，不要复用。
- **Agent Profile**：一组可复用的 runtime / model / mode / thinking / options 组合。
- **Subagent**：父会话内由运行时派生的子代理。它不是 Hub `Session`，不进画布会话树，不单独授权。
- 基本单位仍是 `Session`。不引入 Paseo 的持久化 agent 实体，也不照搬 workspace tabs / 完整编排 UI。

## 1. 阶段总览

| 阶段 | 内容 | 状态 | 依赖 |
|---|---|---|---|
| P0 | 契约、命名、能力矩阵 | 部分完成 | — |
| P1 | Agent Profile | 已完成 | P0 |
| P2 | 运行时 controls / 模型元数据 | 已完成 | P1 |
| P3 | 子代理时间线 UI | 已完成 | P1 事件模型 |
| P4 | 结构化工具详情 + 权限请求 | 待开始 | P3 |
| P5 | 运行时状态 + 自定义运行时别名 | 待开始 | P2 |
| P6 | ACP transformer + 编排工具 | 待开始 | P1/P3 |

## 2. P1 Agent Profile

**目标**：保存一组 runtime/model/options，派生时直接套用；不修改已有会话。

已完成：

- 领域：`AgentProfile`、校验、owner 隔离 CRUD。
- 存储：SQLite `agent_profiles`。
- API：`GET/POST /api/agent-profiles`、`PATCH/DELETE /api/agent-profiles/:id`。
- 派生：`deriveSessionRequest.profileId` 优先提供 agent/model/options。
- Web：派生对话框选择 profile；会话“更多”保存当前配置。
- 验证：typecheck/check/build、954 单测、`e2e/agent-profiles.spec.ts`。

后续：

- 配置管理页（改名/删除/复制）。
- 配置与 `optionSpec` 的兼容检查：运行时升级后某个 option 不存在时，派生要提示而不是静默忽略。

## 3. P2 运行时 controls / 模型元数据

**目标**：把“运行时自报什么就能调什么”从被动列表变成可渲染的通用控件。

已完成：

- `RuntimeOption.kind` 继续作为控件类型：`select` / `boolean`（toggle）。
- 候选项 `OptionValue` 增加可选 `metadata`：`contextWindow`、`maxTokens`、`defaultThinking`、`aliases`、`selectable`、`tags`。
- ACP `mapAcpOptions` 从候选项 `_meta`/`metadata` 搬运上述字段；认不出就忽略。
- 模型选择器显示 `200K 上下文 · 8192 输出 · vision` 一类摘要；`selectable:false` 的模型置灰不可选；别名参与搜索。
- 原生 `<select>` 同样禁用不可选项；compact/完整面板仍共用 `OptionControls`。
- 验证：ACP conformance 覆盖元数据搬运；`model-list` 覆盖别名搜索；OpenAPI 快照更新。

## 4. P3 子代理时间线 UI

**目标**：主会话里看到子代理；不新增 Hub 会话，不增加画布节点。

后端已就绪：

- `subagent start/end` 事件；子事件带 `subagentId`。
- ACP 读取 `opencode/child-session` meta，父工具完成/本轮结束收尾。
- fake agent `--child` 与 runtime/conformance 单测。

已完成：

- `live-core` 把 `subagent start/end` 和带 `subagentId` 的事件折成可嵌套的块；子事件不混入主对话。
- `ChatBlock` 新增可折叠子代理卡：agent、标题、状态、步骤数；展开看子文本/工具/产出物。
- 画布会话卡增加子代理 badge，不新增节点。
- 失败自动展开；运行中显示状态；移动端只显示一行摘要。
- 历史回放、SSE 补帧、fork 继承保持原样；旧会话无 subagent 不受影响。
- 验证：`live-core.test.ts` 覆盖 start→子事件→end；`e2e/subagent.spec.ts` 用 fake ACP `--child` 看到子代理卡与画布 badge。

## 5. P4 结构化工具详情 + 权限请求

**目标**：工具卡不只显示原始 JSON，而是按类型展示；权限请求变成可操作卡片。

- `ProviderToolCallDetail` 对应到 Hub：shell/read/edit/write/search/fetch/worktree/subagent/plan/unknown。
- 工具卡显示命令、路径、diff、搜索结果摘要；原始输入仍可展开。
- 权限请求：kind、actions、suggestions、detail；支持 allow/deny、updatedInput/updatedPermissions。
- 验收：OpenCode/Hermes 的常见工具都有结构化视图；未知工具降级为文本。

## 6. P5 运行时状态 + 自定义运行时别名

**目标**：管理员能看见每个 runtime 是否可用；能配置别名/凭据，但不破坏安全边界。

- runtime snapshot：`ready/loading/unavailable/error`、诊断、模型数、最后探测时间。
- 自定义 Agent Runtime 配置：`extends` 内置 runtime 或 `acp`；command/env/options/models/additionalModels；管理员/worker 校验。
- 别名只影响启动计划，不改 Hub 的 `provider` 语义。
- 验收：runtime 状态可见；别名不影响已有会话；错误配置有明确诊断。

## 7. P6 ACP transformer + 编排工具

**目标**：把供应商私有工具名/通知归一化；给编排 agent 发现和操作其他会话的工具。

- Worker 侧 ACP transformer 钩子：`discover/configure/notification/toolCall`。
- 编排工具（薄封装现有 session/messaging，不重写消息总线）：
  - `list_agent_profiles`
  - `inspect_agent_runtime`
  - `spawn_agent` / `create_session`
  - `set_agent_option`（权限门禁）
  - `get_agent_activity`
- 验收：transformer 不改全局配置、不泄密钥；编排工具受现有权限/限额约束。

## 8. 验证基线

每个阶段完成时必须跑：

```bash
npm run check
npm run typecheck
npm run typecheck:web
node --test --test-concurrency=1 "packages/**/*.test.ts" "apps/server/**/*.test.ts" "apps/worker/**/*.test.ts" "apps/web/src/**/*.test.ts"
npm run build
```

涉及 UI 的阶段再跑对应 Playwright spec；涉及部署时用 `scripts/deploy-aliyun.sh` 或 git bundle 流程，并确认 `/api/health` 与 Worker 在线。
