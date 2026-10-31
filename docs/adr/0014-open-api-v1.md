# ADR 0014：统一开放 API v1

- 状态：**proposed**
- 日期：2026-10-30
- 详见 `docs/design/open-api.md`

## 背景
内部和外部 agent 需要稳定地接入项目管理、任务和智能体对话能力；现有 `/api/*` 是 UI 专用，无版本、无文档、只支持 cookie 登录。

## 决定（拟）
1. 新增 `/openapi/v1` 驱动适配器，复用现有 use case 与 `can()`；公开 DTO 与内部 wire 分离。
2. 用 `@hono/zod-openapi` 生成 `openapi.json`，Scalar 出文档，spec 快照 + 契约测试防漂移。
3. 新聚合 `ApiToken`（个人令牌 / 服务账号），scope 与角色权限取交集，`worker.use_local` 不可授；审计带 via 令牌。
4. 单会话 SSE 公开事件 schema，支持 Last-Event-ID；MCP server 与 webhooks 为后续阶段。
5. v1 只增不删，破坏性变更走 v2 并行 ≥90 天。
