# ADR 0024：模型版会后提炼器（hub 直调项目选的已注册模型）

- 状态：accepted（2026-11-01 David：「提炼可以用项目能用的任何已注册 ModelProvider / 模型（ADR 0013 的 RBAC + 作用域），从 hub 进程调上游，密钥不出 hub；不另搞一份 hub 中转模型列表；项目设置里选，没选就规则版；按提供商 + 项目记用量；守住上限、密钥过滤和 staged 层」）
- 相关：ADR 0013（hub 模型提供商）、ADR 0019（记忆）、设计文档 memory.md §6.1、§16、§17

## 决定

1. **模型来源**：就是 ADR 0013 的 ModelProvider。项目设置里存一个 `hub-<slug>/<model>`（表 `memory_distill_settings`）；`null` = 规则版（默认）。不新增「hub 中转模型」清单。
2. **选的时候核对**（`PUT /api/projects/:id/memory/distill {model}`）：设置人要有本项目的 `memory.review`（和改写入模式同一类），并对该提供商有 `provider.use`、作用域对得上项目团队、模型在提供商的模型列表里（复用 `checkProviderModel`）。审计 `memory.settings`。
3. **用的时候再核对**（每次提炼）：提供商还在、启用、有密钥、作用域仍允许本项目、模型还在列表里；不满足就回落规则版并记日志。
4. **调用路径**：一律由 hub 进程直接调上游（`openai-chat` → `{baseUrl}/chat/completions`；`openai-responses` → `/responses`；`anthropic` → `/v1/messages`），**不管提供商 routing 是 direct 还是 hub**；密钥只在 hub 里解密（`revealKey`），不下发任何 worker。超时 60 秒，回复上限 256 KB。
5. **只在真要提炼时调模型**：全局 `HUB_MEMORY_DISTILL=0`、会话太短、项目当天超 50 次都在调模型**之前**拦下。会话层摘要（`session:`）始终用规则版（只是原文 + 密钥过滤），不调模型。
6. **守住的边界**：输入先过密钥过滤（摘要含疑似密钥 → 整段不送模型、不写）；输出只认 JSON，逐条再过密钥过滤、截断到 1000 字、总数 ≤ 5；状态只给 **staged**（第一条 episodic）/ **proposed**（其余 procedural，进确认队列）——服务端再兜一层，非这两种状态的候选丢弃；绝不直接 active。
7. **用量**：提供商累计（`requests / errors / bytesIn / bytesOut`，和中转一样）+ 每次调用一条审计 `memory.distill`（target `project:<id>`，带团队、模型、成败、字节数、耗时）——这就是按「提供商 + 项目」的记录。
8. **失败回落**：网络错、超时、非 2xx、JSON 不对、零条候选 → 规则版，记一次 error。

## 保守选择（ADR 没说，列给 David）

- **个人提供商不能用于项目提炼**（选的时候拒，用的时候也拒）：后台任务没有「当前用户」，用个人密钥替整个项目付费太隐蔽。要放开再说。
- 会话层摘要不走模型（省钱，也保持「原文」可核对）。
- 提示词固定（中文，要求只输出 JSON、不编造、不输出凭据），不按项目定制。
- 超时 60 秒、`max_tokens` 1500、回复上限 256 KB 写死。
- 每天 50 次上限仍是进程内计数（沿用 P2），没有落库。

## 补充：项目级提炼开关（2026-11-01，第 4 项）

- `memory_distill_settings.enabled`（默认 1，老库自动 `ALTER TABLE` 加列）。`PUT /api/projects/:id/memory/distill {enabled}`，权限 `memory.review`，审计 `memory.settings`。
- 顺序：全局 `HUB_MEMORY_DISTILL=0` 优先 → 项目关 → 最短会话 → 每日上限；关了只跳过项目层提炼，session: 压缩摘要照写（它不是「提炼」，只是原文）。
- 保守选择：关掉不删已有的提炼条目；关掉时模型下拉框灰掉但保留选择。
