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
| P0 | 契约、命名、能力矩阵 | 已完成 | — |
| P1 | Agent Profile | 已完成 | P0 |
| P2 | 运行时 controls / 模型元数据 | 已完成 | P1 |
| P3 | 子代理时间线 UI | 已完成 | P1 事件模型 |
| P4 | 结构化工具详情 + 权限请求 | 已完成 | P3 |
| P5 | 运行时状态 + 自定义运行时别名 | 部分完成 | P2 |
| P6 | ACP transformer + 编排工具 | 已完成（后续按 runtime 补 codec） | P1/P3 |

## 2. P0 能力矩阵

已完成：

- `subagent` 进入 `CapabilityName` / `CAPABILITY_NAMES` / `CAPABILITY_LABELS`，UI 用统一三态判断，不按 agent 名字写分支。
- 后加能力可缺省：不报 `subagent` 的运行时按 `denied` 处理，旧 descriptor 不用一起改。
- OpenCode（带 `opencode` codec）报 `available`；Hermes 报 `limited`（只有开始/结束，没有子会话时间线）；Pi/Grok/通用 ACP 默认 `denied`。
- `allowsFor` / `unavailableReason` 对缺省能力使用按名称的默认值，避免把 `subagent` 误判成 `branch_at_turn`。

## 3. P1 Agent Profile

**目标**：保存一组 runtime/model/options，派生时直接套用；不修改已有会话。

已完成：

- 领域：`AgentProfile`、校验、owner 隔离 CRUD。
- 存储：SQLite `agent_profiles`。
- API：`GET/POST /api/agent-profiles`、`PATCH/DELETE /api/agent-profiles/:id`。
- 派生：`deriveSessionRequest.profileId` 优先提供 agent/model/options。
- Web：派生对话框选择 profile；会话“更多”保存当前配置。
- 配置管理页：会话“更多 → 管理 Agent 配置…”和派生对话框“管理”；支持改名、改模型/备注、复制、删除。
- 配置与 `optionSpec` 的兼容检查：派生对话框提示当前运行时未上报的 agent/模型/选项；后端仍会拒绝不存在的模型。
- 验证：typecheck/check/build、单测、`e2e/agent-profiles.spec.ts`（保存 → 管理页改名 → 派生套用）。

## 4. P2 运行时 controls / 模型元数据

**目标**：把“运行时自报什么就能调什么”从被动列表变成可渲染的通用控件。

已完成：

- `RuntimeOption.kind` 继续作为控件类型：`select` / `boolean`（toggle）。
- 候选项 `OptionValue` 增加可选 `metadata`：`contextWindow`、`maxTokens`、`defaultThinking`、`aliases`、`selectable`、`tags`。
- ACP `mapAcpOptions` 从候选项 `_meta`/`metadata` 搬运上述字段；认不出就忽略。
- 模型选择器显示 `200K 上下文 · 8192 输出 · vision` 一类摘要；`selectable:false` 的模型置灰不可选；别名参与搜索。
- 原生 `<select>` 同样禁用不可选项；compact/完整面板仍共用 `OptionControls`。
- 验证：ACP conformance 覆盖元数据搬运；`model-list` 覆盖别名搜索；OpenAPI 快照更新。

## 5. P3 子代理时间线 UI

**目标**：主会话里看到子代理；不新增 Hub 会话，不增加画布节点。

后端已就绪：

- `subagent start/end` 事件；子事件带 `subagentId`。
- ACP 注册 `opencode/session/child_update` 扩展通知（先声明 client `_meta` 能力），父工具完成/本轮结束收尾。
- fake agent `--child` 与 runtime/conformance 单测。

已完成：

- `live-core` 把 `subagent start/end` 和带 `subagentId` 的事件折成可嵌套的块；子事件不混入主对话。
- `ChatBlock` 新增可折叠子代理卡：agent、标题、状态、步骤数；展开看子文本/工具/产出物。
- 画布会话卡增加子代理 badge，不新增节点。
- 失败自动展开；运行中显示状态；移动端只显示一行摘要。
- 历史回放、SSE 补帧、fork 继承保持原样；旧会话无 subagent 不受影响。
- 验证：`live-core.test.ts` 覆盖 start→子事件→end；`e2e/subagent.spec.ts` 用 fake ACP `--child` 看到子代理卡与画布 badge。

## 6. P4 结构化工具详情 + 权限请求

已完成：

- `toolView` 识别 `shell`、`edit`、`read`、`search`、`fetch`、`worktree`、`subagent`、`plan`、`file`、`raw`；未知工具降级为原始 JSON。
- 工具卡按类型显示命令、路径/行号、diff、搜索词、URL、子代理、计划文本；原始输入仍可展开。
- 权限请求沿用现有 `approval` 卡：显示标题/详情、允许/拒绝、倒计时和超时拒绝；没有新增平台自造权限。
- 验证：`tool-format.test.ts` 覆盖各类型识别与摘要；E2E 工具卡不回归。

## 7. P5 运行时状态 + 自定义运行时别名

**目标**：管理员能看见每个 runtime 是否可用；能配置别名/凭据，但不破坏安全边界。

已完成：

- 运行时状态沿用 `/api/workers`：Worker online/offline、harness readiness、agent 清单与诊断；管理页用 `HarnessBadges`/`RecheckButton` 展示，`/api/workers/:id/probe` 重新检测。
- 自定义运行时别名走 Worker 的 `ACP_AGENTS`（JSON 数组）：`id/label/command/args/env/models/defaultModel/optionOverrides`；`env` 只由操作者配置，`models` 是发现失败时的兜底，`defaultModel` 影响派生默认模型，`optionOverrides` 可把 ACP `mode` 映射成 `agent`。
- 别名是启动配置，只影响之后启动的会话；已有会话不变。改完需重连/重启 Worker。
- 未做管理 UI 和热加载；`ACP_AGENTS` 能执行任意命令，属于操作者信任边界。

验收：Worker/agent 状态与 readiness 可见；别名能被 Worker 报成独立 descriptor；非法条目跳过并回退。

## 8. P6 ACP transformer + 编排工具

**目标**：把供应商私有工具名/通知归一化；给编排 agent 发现和操作其他会话的工具。

已完成（P6a）：`agent.list_profiles`、`agent.inspect_runtime`、`agent.activity`、`agent.spawn`、`agent.set_option`，薄封装现有 session/profile 用例；spawn 限同任务、set_option 限同项目同 owner。

已完成（P6b 基础设施）：`AcpRuntimeCodec` / `AcpSessionCodec`；OpenCode 的子会话 `_meta`、父工具配对、start/end 已从 `acp-runtime.ts` 迁到 `codecs/opencode.ts`；通用 mapper 仍是默认路径，codec 可返回 `null` 回退。`ACP_AGENTS` 只能配数据，不能注入 codec。设计见 `docs/design/acp-runtime-codec.md`。

待做（P6b 后续）：接 Claude Code/Codex 等工具名/通知差异明显的 runtime 时，新增对应 codec；没有具体私有格式前不再造空钩子。
- 编排工具（薄封装现有 session/messaging，不重写消息总线）：
  - `list_agent_profiles`
  - `inspect_agent_runtime`
  - `spawn_agent` / `create_session`
  - `set_agent_option`（权限门禁）
  - `get_agent_activity`
- 验收：transformer 不改全局配置、不泄密钥；编排工具受现有权限/限额约束。

## 9. 验证基线

每个阶段完成时必须跑：

```bash
npm run check
npm run typecheck
npm run typecheck:web
node --test --test-concurrency=1 "packages/**/*.test.ts" "apps/server/**/*.test.ts" "apps/worker/**/*.test.ts" "apps/web/src/**/*.test.ts"
npm run build
```

涉及 UI 的阶段再跑对应 Playwright spec；涉及部署时用 `scripts/deploy-aliyun.sh` 或 git bundle 流程，并确认 `/api/health` 与 Worker 在线。
