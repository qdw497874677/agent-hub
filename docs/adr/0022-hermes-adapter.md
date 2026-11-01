# ADR 0022：Hermes Agent 运行时适配器

- 状态：accepted（2026-10-31 David，设计文档 §12 D1–D7 全部选 A）
- 设计：`docs/design/hermes-adapter.md`
- 相关：ADR 0013（统一运行时适配器 / 模型提供商）、0014（Worker 资源）、0019（记忆，PR #123）、0020（上下文策略，PR #123）、0021（运行时套件，PR #123）

## 背景

Hermes Agent 提供 API Server（OpenAI 兼容接口 + Runs API：幂等提交、SSE、stop、批准、澄清、结果未知处理、并发上限）和 ACP 两条集成路径（2026-10-31 核对原文）。

## 决定

1. 新增 `hermes` 运行时适配器，实现现有 `RuntimeAdapter` / `AgentRuntime` 契约，走 API Server 的 Runs API；P0 先用现有 acp 适配器冒烟。
2. hub 只用自己建的 Hermes 会话；别的入口拥有的会话返回 409 `permission_denied`，不接管。
3. 每次提交带持久化的 `Idempotency-Key`；429 / 503 用同一个键退避重试；`unknown` 结果不自动重发，由人确认。
4. 批准 / 澄清映射到 hub 的人工介入卡，原样带回 `request_id` 和 `execution_generation`。
5. hub 记忆只通过 MCP 工具；Hermes 原生记忆是 L3，默认关，开启时用 `X-Hermes-Session-Key` 限定作用域。
6. 模型只经 Worker 本机中继，agent 看不到真实密钥；`run.completed.runtime` 用于记账。
7. 每个 Worker 一个 gateway，只绑 127.0.0.1，随机端口和随机 `API_SERVER_KEY`，不复用用户自己的 Hermes 配置。
8. 作为 ADR 0021 runtime bundle 安装。

## 后果

- 得到幂等、可恢复、可记账的 Hermes 集成；代价是要管理一个常驻 gateway 进程和它的密钥。
- 设计文档 §14 列出的未核对项要在 P1 前实测；如果 MCP 按会话接入做不到，退回 ACP 路径（D7）。

## 修订（2026-11-01）

- P1 落地：`packages/adapters/hermes`（Runs API），§14 实测结果与实施细节见 docs/design/hermes-adapter.md §15。
- ~~D2-A 调整为「每个 hub 会话一个网关」~~ → 2026-11-01 David 要求回到 D2-A：**每个 worker 一个网关**，会话用 Hermes 自己的会话（`ahub-<id>` + `X-Hermes-Session-Key`）隔开。按会话的中继凭据走 worker 内分流器（模型名带路由）；无每轮 cwd → 工作区写进 instructions、网关 cwd 是中性空目录；hub MCP 工具在共用网关下暂不提供（分不清调用方会话，宁缺不串）。细节与实测见设计文档 §17。
- D7 退路未触发：~~hub MCP 通过每会话 profile 的 `mcp_servers` 注入~~（每 worker 一个网关后暂停，见 §17.4）。

## 补充：共用网关下的 hub MCP —— D7 回退落地（2026-11-01）

- 核实：session key 不会转给 MCP（设计 §14.3），worker profile + 本地中继分不清是哪个会话在调 hub 工具 → 按 D7 回退到 ACP。
- 新增运行时 `hermes-acp`（`hermes acp`，走现有 ACP 运行时，`packages/adapters/acp/src/hermes-acp.ts`），只在 `HERMES_COMMAND` / `WORKER_HERMES=1` 时注册，和共用网关的 `hermes` 并存：
  - hub 工具：ACP `session/new` 的 `mcpServers` 是会话级的（Hermes 0.22.5 的 `gateway.session_local_mcp`），toolShim 照常下发；
  - 每会话独立 `HERMES_HOME`（`$HERMES_HUB_ROOT/acp/ahub-<会话>`），config.yaml 只引用 `HUB_PROVIDER_BASE_URL` / `HUB_PROVIDER_TOKEN` 变量名，值只在子进程 env；
  - 实测：`hermes acp` 会在该 home 下自起一个 `gateway run --idle-exit`，所以是一会话一网关，空闲自退；
  - 没选 hub 模型：给一个空 home（`acp/_unrouted`），Hermes 拒绝建会话（model 为空），不会读用户的 `~/.hermes`。
- 保守选择（列给 David）：不让多个 ACP 会话共用一个 home（网关按第一个会话的 env 起，会串令牌）；默认模型取提供商清单第一个，会话里的换模型走 ACP `set_session_model`；共用网关版 `hermes` 继续不带 hub MCP。
