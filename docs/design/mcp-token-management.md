# 外部 MCP / OpenAPI 管理访问令牌

配套 `tokens:manage`。内部管理接口仍是 `/api/tokens`（只认登录态，不认 Bearer）；这里只讲对外开放的面。

## 第一张管理令牌只能从界面拿一次

无人值守验收测试需要先有一张带 `tokens:manage` 的管理员个人令牌，这张令牌**不能**再由另一张令牌签发：

1. 管理员在网页登录，打开「外部接入」或「访问令牌」。
2. 新建个人令牌，勾选 `管理访问令牌`（`tokens:manage`），再按需要勾选自用的业务 scope（例如 `projects:*`、`sessions:*`）。
3. `tokens:manage` 默认关闭，只有团队 owner / admin 或集群管理员能授予；不能给只限项目的令牌，也不能给 bot 凭据。
4. 明文只显示这一次，保存后用它接 MCP。之后的短期令牌都由这张管理令牌经 MCP 签发，不必再回界面。

## 工具与路由

| MCP 工具 | 权限 | REST | 说明 |
| --- | --- | --- | --- |
| `token_list` | `tokens:manage` | `GET /openapi/v1/tokens` | 列出可管理的令牌。形状 `{ tokens: [...] }`，无哈希、无明文 |
| `token_create` | `tokens:manage` | `POST /openapi/v1/tokens` | 签发个人令牌。明文只在本次 `token` 字段出现 |
| `token_rotate` | `tokens:manage` | `POST /openapi/v1/tokens/{tokenId}/rotate` | 吊销旧的、签发同权限新令牌。明文只一次 |
| `token_revoke` | `tokens:manage` | `POST /openapi/v1/tokens/{tokenId}/revoke` | 吊销。记录保留 |

业务规则复用 `createApiToken` / `rotateApiToken` / `revokeApiToken` / `listApiTokens`，不另写一套。

## 权限与提权约束

- 新增 scope：`tokens:manage` → 权限点 `token.manage`。默认关闭。
- 经令牌只能签发**个人令牌**，scopes 必须是调用方令牌的子集。
- **不能**再签发带 `tokens:manage` 或 `providers:manage` 的令牌（不能提权）。
- 必须设置 `expiresAt`，最长 30 天；不能永不过期。经令牌轮换时有效期同样封顶 30 天。
- 项目级令牌和 bot 凭据拿不到 `tokens:manage`（授予时拒绝）。

## 审计与密钥

创建 / 轮换 / 吊销写既有 `token.create` / `token.rotate` / `token.revoke` 记录，细节带名字、scope、是否限定项目，以及「经令牌」来源。响应、日志、审计都不得出现明文。

## 无人值守验收测试配方

```
# 0. 管理员在界面签发第一张带 tokens:manage 的个人令牌（只此一次）
token_list
token_create { name, scopes: [...子集，不含 tokens:manage / providers:manage], expiresAt, clientRequestId }
# 用返回的 token 跑验收（不要写入日志）
token_rotate { tokenId, clientRequestId }   # 可选
token_revoke { tokenId, clientRequestId }   # 验收结束务必吊销
```
