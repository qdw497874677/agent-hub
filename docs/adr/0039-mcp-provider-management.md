# ADR 0039：外部 MCP / OpenAPI 管理模型提供商

- 状态：proposed（实现随 PR 提交，未合并、未部署）
- 日期：2026-11-18
- 关联：ADR 0013（Hub 模型提供商）、0015（开放 API v1）；设计稿 `docs/design/mcp-provider-management.md`

## 背景

外部 agent 只能经 MCP 选用已经配好的模型（`providers:use`），不能配置供应商、密钥或路由。这些能力原先只在内部 `/api/providers`。

## 决定

1. **同一套领域逻辑。** 开放 API v1 和 MCP 工具转调现有 use case，不复制校验、授权或密钥存取。
2. **新 scope `providers:read` / `providers:manage`。** 默认关闭；只有管理员能授予 manage；项目级令牌和 bot 凭据永远拿不到。调用时再检查一遍。
3. **密钥只写不回。** 响应、日志、审计、错误都不含明文。引用已存 Hub 密钥留到后续（现有密钥库是资产用的，和提供商密钥不是同一套）。
4. **删除和改机器路由要显式 `confirm: true`。** 否则返回影响说明，不执行。
5. **全站提供商和机器路由。** 令牌拿不到 `hub.providers`；集群管理员持有 `providers:manage` 即可。

## 后果

- 外部 agent 可以独立完成「配置国内智谱 → 探测/测试 → 开会话 → 用完删除」。
- 管理面风险更高，靠管理员授予、项目级禁令、确认闸门和审计留痕约束。
