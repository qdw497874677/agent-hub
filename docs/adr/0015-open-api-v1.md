# ADR 0015：统一开放 API v1（含 MCP）

- 状态：**accepted**
- 日期：2026-10-30
- 详见 `docs/design/open-api.md`；规范快照 `docs/openapi/v1.json`；在线文档 `/openapi/v1/docs`

## 背景
内部和外部 agent 需要稳定地接入项目管理、任务和智能体对话能力；现有 `/api/*` 是 UI 专用，无版本、无文档、只支持 cookie 登录。

## 决定
1. **独立前缀 `/openapi/v1`**，与 UI 的 `/api` 分开；是一个新的驱动适配器（六边形），复用现有 use case 与 `can()`，不复制业务规则。
2. **只认 `Authorization: Bearer ahp_…` 令牌**，不认 cookie（因此无 CSRF）；`/api` 也不认 `ahp_` 令牌。令牌不能再创建/吊销令牌。
3. **两种令牌**：个人令牌（代表本人）和团队服务账号（团队里一个不占席位、不出现在成员列表的独立成员，需要 `member.manage` 才能建）。
4. **权限 = 本人角色权限 ∩ scopes**（`projects:read|write`、`sessions:read|write`、`workers:read`）；`worker.use_local` 和所有 hub 级权限**永远授不出去**，带令牌的请求碰到本机 Worker 一律 403。
5. **有效期**：默认永不过期；可选过期时间；可随时吊销；本人被停用/删除即失效；只存 SHA-256 哈希，明文只在创建响应里出现一次。
6. **范围**：项目、任务、工作日志、会话（开、分叉、发消息、打断、改选项、事件、活动）+ 新增 `GET /tasks`、`GET /tasks/:id`、`GET /sessions/:id`、`GET /sessions/:id/stream`（SSE，支持 `Last-Event-ID` / `?after=`）。
7. **MCP 第一期就上**：官方 `@modelcontextprotocol/sdk`，streamable HTTP（无状态）挂在 `POST /openapi/v1/mcp`；同一个令牌、同一套权限；工具由路由表自动生成，内部转发到对应的 v1 接口。
8. **规范**：`@hono/zod-openapi` 生成 OpenAPI 3.1，Scalar 出文档；`docs/openapi/v1.json` 快照 + 测试比对，改接口必须 `npm run openapi:snapshot` 并在 PR 里说明。
9. **审计**：经令牌的操作在会话活动 / 审计里写「via 令牌「名称」」，消息作者带 `via`，对话页显示 via 标记；令牌的建 / 吊销写 `token.create` / `token.revoke`。
10. **限流**：每令牌每分钟 120 次请求（`HUB_API_RATE_MAX`）、20 次 prompt（`HUB_API_PROMPT_RATE_MAX`）、最多 5 条并发事件流（`HUB_API_STREAM_MAX`）；超了 429 + `Retry-After`。
11. **兼容**：v1 只增不删；破坏性变更走 v2，并行 ≥ 90 天。

## 后果
- 多一张 `api_tokens` 表、一个设置面板（「账号 → 访问令牌」）。
- webhooks、OAuth 授权码流程、按项目限定的令牌留到后续阶段。
