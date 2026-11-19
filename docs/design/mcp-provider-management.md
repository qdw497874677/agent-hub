# 外部 MCP / OpenAPI 管理模型提供商

配套 ADR 0039。内部管理接口仍是 `/api/providers`；这里只讲对外开放的面。

## 工具与路由

| MCP 工具 | 权限 | REST | 说明 |
| --- | --- | --- | --- |
| `provider_list` | `providers:read`（`providers:use` / `providers:manage` 也行） | `GET /openapi/v1/providers` | 提供商、模型、机器路由。不含密钥 |
| `provider_create` | `providers:manage` | `POST /openapi/v1/providers` | 新建。`apiKey` 只写不回 |
| `provider_update` | `providers:manage` | `PUT /openapi/v1/providers/{providerId}` | 改配置，不改密钥 |
| `provider_set_key` | `providers:manage` | `PUT /openapi/v1/providers/{providerId}/key` | 轮换密钥 |
| `provider_probe` | `providers:manage` | `POST /openapi/v1/providers/probe` | 探测模型列表 |
| `provider_test` | `providers:manage` | `POST /openapi/v1/providers/{providerId}/test` | 从机器实测连通 |
| `provider_delete` | `providers:manage` | `DELETE /openapi/v1/providers/{providerId}` | 要 `confirm: true`，否则返回影响说明 |
| `provider_routing_set` | `providers:manage` | `PUT /openapi/v1/providers/routing/{workerId}` | 要 `confirm: true`；只有集群管理员的管理令牌能改 |

业务规则复用领域层（`createProvider` / `canManageProvider` 等），不另写一套。

## 权限

- 新增 scope：`providers:read`（只看）、`providers:manage`（看、用、管）。已有 `providers:use` 不变。
- `providers:manage` 默认关闭。只有团队 owner / admin 或集群管理员能授予。
- 项目级令牌和 bot 凭据不能获得 `providers:manage`（授予时拒绝，调用时再挡一层）。
- 令牌拿不到 `hub.providers`。集群管理员的管理令牌凭 `provider.manage` 可建全站提供商、改机器路由。
- 服务账号角色是 member，但管理员授予 `providers:manage` 后可管本团队提供商。
- 内置 bot 凭据权限上限不变，不含管理。

## 密钥

- 只写不回：任何响应、日志、审计、错误都不得出现明文。
- 提供商密钥走自己的加密存储，和资产密钥库不是同一套。暂不支持「引用已存的 Hub 密钥」代替明文；这是后续事项。

## 确认闸门

`provider_delete` 和 `provider_routing_set` 不带 `confirm: true` 时不执行，返回将受影响的模型 / 会话用量或路由变更说明。

## 审计

每次变更写既有 `provider.create` / `update` / `key` / `delete` / `test` / `routing` 记录，细节带「经令牌 名称 / id」，不含密钥。
