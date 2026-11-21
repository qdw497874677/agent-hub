# MCP 出口策略（#243）

状态：实现（2026-11-21）。作用范围：hub 代连远端 http MCP（`apps/server/src/mcp-relay.ts`）与
MCP OAuth `client_credentials` 取 token（`apps/server/src/mcp-oauth.ts`）。

## 1. 默认行为

两条链路共用 `apps/server/src/mcp-egress.ts` 里的同一个默认出口（同一个 app 私有 Undici `Agent`）：

- 只允许 `https:`；URL 带 userinfo（`user:pass@`）直接拒绝。
- 静态拒绝字面量内网 / 保留地址、单段主机名，以及 `localhost`、`*.localhost`、`*.local`、
  `*.internal`、`*.home.arpa`、`*.lan`。
- 连接时由 `Agent({ connect: { lookup } })` 校验 DNS 解析结果；解析出任何一个内网 / 保留地址就失败。
  `lookup` 同时处理 Node 的 single（`address, family`）与 `all: true`（地址数组）回调。
- 不跟随重定向：secure fetch 强制 `redirect: 'error'`，不依赖 MCP SDK 的 redirect 选项。
- 不覆盖 `Host`：URL / `Request` / `init.headers` 里出现 `Host` 都在请求前拒绝。
- 不设置 `connect.servername`：TLS SNI 与证书校验继续用 URL 主机名；`lookup` 只替换「主机名 → 地址」。
- 不使用全局 dispatcher：`Agent` 是模块私有的，只给 MCP 出口用；`close()` 由持有方负责。

OAuth token 地址额外要求 `requireHttps: true`：即使配置了 HTTP 例外，token 地址也必须 HTTPS。
OAuth 的 `Authorization` / body 凭据仍在内存里，错误与日志只保留脱敏后的消息。

## 2. 运维例外（只认精确主机名）

两个环境变量都在 hub 进程启动时读取；用逗号分隔，比较前做小写、去空白、去尾点。
**不支持通配 / 后缀**：`*.corp.example` 或 `corp.example` 不会覆盖 `mcp.corp.example`。

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `MCP_EGRESS_ALLOW_PRIVATE_HOSTS` | 允许这些**精确主机名**解析到内网 / 保留地址 | 空（全拒） |
| `MCP_EGRESS_ALLOW_HTTP_HOSTS` | 允许这些**精确主机名**使用明文 HTTP | 空（全拒） |

示例：

```bash
# 只放开一台内网 MCP；仍然要求 HTTPS
MCP_EGRESS_ALLOW_PRIVATE_HOSTS=mcp.corp.example

# 只放开一台明文 MCP（该主机仍不能解析到内网，除非同时在上面的列表里）
MCP_EGRESS_ALLOW_HTTP_HOSTS=legacy-mcp.example.com
```

注意：

- HTTP 例外与私网例外互相独立。明文内网地址要两个列表都精确命中。
- OAuth token 地址不受 HTTP 例外影响。
- 例外是进程级配置，不是资产字段；资产不能自行扩大出口范围。
- 改环境变量后需要重启 hub 才生效。

## 3. 与现有代码的接线

- `createRemoteClients()` 默认使用 `defaultMcpEgress()`；`StreamableHTTPClientTransport` 拿到的是
  校验后的 `URL` 和同一个 secure `fetch`。
- `serveMcpRelay()` 在把展开后的 `RemoteMcpTarget` 交给代理前先做一次静态 URL / Host 校验；
  即使测试注入了假的 `RemoteClients`，私网地址与 Host 覆盖也不会被放行。
- `createMcpOAuth()` 默认使用共享出口；relay 显式传入同一个 `egress` / `fetch`，所以 relay 与 OAuth
  不会各自建一套策略。
- `apps/server/src/main.ts` 不需要改：`createRemoteClients()` / `serveMcpRelay()` 的旧调用签名保持兼容。

## 4. 验证

聚焦用例（不访问真实网络；DNS / fetch 都是注入的合成结果）：

```bash
node --test --test-concurrency=1 \
  apps/server/src/mcp-egress.test.ts \
  apps/server/src/mcp-oauth.test.ts \
  apps/server/src/mcp-relay.test.ts
```

覆盖：URL 静态策略、userinfo、精确主机例外、IPv4 / IPv6 / 内嵌 IPv4 / NAT64 / 6to4 保留段、
`lookup` 的 single 与 `all` 分支、混合公网 + 内网解析、Host 覆盖、`redirect: 'error'`、私有 Agent 绑定。

## 5. 边界

- 静态检查无法判断任意域名最终解析到哪里；那部分由连接时 `lookup` 负责，不能只靠静态检查。
- DNS 结果在 lookup 时校验后交给 `net.connect`，不重新解析；这避免「校验后再次解析」的 TOCTOU。
- 如果运维把某个精确主机名放进私网例外，该主机名解析出的所有地址都会放行；这是显式信任决定。
- 不覆盖非 HTTP 的 MCP 传输（当前远端 MCP 只支持 http / streamable HTTP）。
