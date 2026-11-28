# 架构与安全评审（2026-11-20，HEAD `2885ccf`）

两条只读评审线：架构层、安全与正确性。除标注「已验证」的条目外，其余为读码结论。修复进度见 §6。

## 1. 一句话结论

端口清晰、装配失控：`packages/domain` 的生产代码不碰 IO，门禁是机械的；风险集中在 `apps/server/src/main.ts`（1,946 行、约 16 个 `setInterval`）——组合根、定时对账、跨队列收尾焊在一个过程式文件里，一致性靠多条 1s/10s 泵兜底，漏的是「托管进程还在、帧已经丢」那一类。

| 面 | 规模（不含测试） |
| --- | --- |
| `apps/web` | 41,577 行 / 79 测试文件 |
| `packages/domain` | 35,628 行 / 103 |
| `apps/server` | 16,515 行 / 54 |
| `packages/node-gateway` | 10,413 行 / 34 |
| `packages/adapters` | 7,491 行 / 36 |
| `packages/storage-sqlite` | 6,677 行 / 42 |
| `packages/contract` | 3,485 行 / 3 |
| 合计 | 约 116k 行，356 个测试文件，2,304 用例 |

最大的源文件：`apps/server/src/main.ts` 1,946、`packages/node-gateway/src/worker-link.ts` 1,470、`apps/server/src/openapi/app.ts` 1,419、`apps/web/src/shell/api.ts` 1,400、`packages/node-gateway/src/server-gateway.ts` 1,378、`packages/domain/src/testing/in-memory.ts` 1,369（fake 世界比多数实现文件大）。

## 2. 安全：必须修

### 2.1 git 主机白名单被非规范回环绕过（已验证）

有 `asset.submit` 的成员提交 `git@127.1:repo.git` 或 `https://[::ffff:127.0.0.1]/x.git`，`checkGitSourceUrl` 放行，hub 侧的 git 真的去连本机。

- 成因：`packages/domain/src/asset-git-host.ts:35-73` —— `gitUrlHost` 对 scp 形式只切到第一个冒号；`isBlockedGitHost` 只认四段点分十进制与 `::1`/`::`。
- 入口：`packages/domain/src/use-cases/assets.ts:270,290`、`apps/server/src/openapi/app.ts:308-339`。
- 修法：判定前把主机规整成规范 IP（IPv4-mapped、inet_aton 简写、八/十六进制均算），覆盖 `0.0.0.0`、`169.254/16`、`10/8`、`172.16/12`、`192.168/16`、`fe80::/10`、`fc00::/7`。不做 DNS 解析。

### 2.2 项目成员能分叉别人的会话（推断，未跑请求）

被共享进项目的 member 调 `/sessions/fork`：中间件只查项目级 `session.fork`，用例只再查 worker，新会话继承来源的 `agentSessionRef`，成员因此能读到别人的 agent 会话文件。

- `session.fork` 不在 `SESSION_SCOPED`（`apps/server/src/access.ts:96-127`）；角色 scope 是 `own`（`packages/domain/src/access.ts:132`），但没把会话当资源传进去，`sharedWith` 直接放行（`:361`）；`packages/domain/src/use-cases/sessions.ts:275-315` 不再核对创建者。
- 修法：分叉走 `authorizeSession(..., 'session.fork')`，与 `session.read` 同一条创建者判定。

## 3. 安全：建议修

1. **幂等键不含请求体、无并发占位**：`apps/server/src/openapi/idempotency.ts:40-42` 键为 `sha256(authorization)|method|path|key`；`:59-82` 先读后写。同 key 不同 body 会回放旧结果，两个并发请求都能通过。
2. **TTL 是死代码**：`:82` `void ttl`；`packages/storage-sqlite/src/mcp-replays.ts:17-24` 的 `get` 不看 `created_at`，清理只在下一次 `put`。
3. **存在性泄露**：`packages/domain/src/use-cases/authorization.ts:88-101`（会话）、`:188-203`（工作空间）在无权时返回 forbidden 而非 notFound。
4. **过期授权只靠装配层过滤**：`packages/domain/src/access.ts:276-286` 的 `grantMatches` 只看 `revokedAt`，`expiresAt` 由 `withAccess` 提前滤掉；别的调用方直接组 Principal 就会放行。
5. **投递先标记再发送**：`packages/domain/src/use-cases/delivery.ts:61` 先写 `sending` 再派发；定时泵有 `pumping`（`main.ts:716-722`），`releaseAfterTurn`（`:401`）不拿；`messaging.ts:265-267` 同样先 `delivered` 再投。
6. **OAuth 缓存键不含 secret**：`apps/server/src/mcp-oauth.ts:81-126` 键为 `tokenUrl|clientId|scope|audience`，轮换密钥后到旧 token 到期前仍可能命中。
7. **`scrubCredentials` 漏形状**：`packages/node-gateway/src/setup-script.ts` 不覆盖 `glpat-`、短 bearer、数字开头的 `user:pass@`；且 extras 目前能覆盖受保护 env。
8. **空 Host 放行**：`apps/server/src/request-guard.ts` 的 `hostAllowed` 在 Host 为空时返回 true。

## 4. 架构：结构性问题

### 4.1 组合根已经是上帝对象（P1）

`main.ts` 顶层 import 两段就超过 50 个（`:100-157`），直接 import 三个 connector、hono、child_process，并 `new` 出 inbox、三条 outbox、files、git、rewind、memory、bots、preview；`:685`、`:744`、`:805` 用 `(deps as { … })` 在装配中途补字段，依赖顺序靠注释（`:748`）维持。

改法：按子系统抽 `wireX(deps)`，`main` 只留顺序与定时器登记；缺的字段补进 `Deps` 类型，删掉三处断言。

### 4.2 一致性是一组互不知晓的定时器（P1）

- 启动 `reconcileInterrupted`（`packages/domain/src/use-cases/sessions.ts:362`）把所有 running 标成 interrupted。
- 运行中：三条 outbox 各 1s（`main.ts:635/653/667`）、`pumpDeliveries` 1s（`:717`）、`recoverOrphanedTurns` 10s（`:726`）、stall 最多 30s（`:1595`）、connector 15s、dispatcher 10s。
- `turnFinished`（`main.ts:701-712`）只订阅 `event.kind === 'ended'`，注释却说 `idle` 也会到。
- `recoverOrphanedTurns`（`packages/domain/src/use-cases/delivery.ts:138`）在 `hosting.has` 时直接 `continue`：旧协议丢帧、进程还登记着，队首会一直堵（注释 `:118-120` 记的正是这类事故）；stall 只 warn，不收尾。

改法：`idle` 帧也进 `turnFinished`（inbox 已要求幂等）；把「delivered 超过 `ORPHAN_TURN_MS` 且 journal 无新事件」从 `hosting.has` 解耦——托管进程在但这一轮没动静，也该失败收尾。

### 4.3 协议只有整数硬切，没有「加字段必须升版」的门禁（P2）

`packages/contract/src/wire/worker.ts:25` `PROTOCOL_VERSION = 7`；`:13-24` 记录 v3–v7 每次都硬切。同文件 `welcome.accepts`/`capabilities`（`:385-392`）注释写「不升版本」；`start_session` 的 `assetIds`/`pinned`/`mcp` 都是 `.optional()`（`:343-347`）。拒连只比整数（`server-gateway.ts:714,758`）。

v4/v5/v7 的事故都是「旧 worker 把缺省读成另一种意思」。改法：给已踩过的帧加快照测试——字段语义翻转时强制 `PROTOCOL_VERSION` 变档；capabilities 继续走可选帧，但语义翻转不许走那条路。

### 4.4 SQLite 迁移无版本表，`COALESCE` 仍吞显式清空（P2）

`packages/storage-sqlite/src/store.ts:231-257` 每次启动 `PRAGMA table_info` + `ALTER`；`:254-257` 每次启动重跑 `UPDATE … COALESCE(MAX(turn),0)`。upsert 里 `asset_set_ids`、`tasks.branch`、`sessions.asset_ids`/`asset_set_ids` 仍是 `COALESCE(excluded, 旧值)`（`:273/:288/:324-325`）；`default_agent` 已按专用 UPDATE 修好（`:274/:301-310`）。

改法：资产与 branch 也改成专用 UPDATE；启动修复收敛到一次并记录。

### 4.5 幂等是声明（P2）

大量写路由标 `idempotent: true`（`routes.ts`），而真正挡重放的是 `Idempotency-Key` 中间件；`token_rotate`、`provider_delete` 这类破坏性操作也声明了幂等。`mcpIdempotentHint` 对客户端承诺了服务端并不完全兑现的能力。见 §3.1/3.2。

### 4.6 前端门禁没盖住 shell（P2）

`scripts/check-import-boundaries.mjs:88-100` 只禁 atoms→surfaces、im↔workbench。`apps/web/src/shell/app.tsx:5-26` 同时 import 两面；`shell/api.ts:98`、`shell/dialogs.tsx:23` 再 import workbench 类型；`atoms/{services-section,files-browser,chat-blocks}.tsx` 已经发请求、拿 contract DTO。

改法：shell 只许 import 两面的 `manifest.ts` 与 atoms；带请求的 atoms 迁回各自 surface。

### 4.7 `inTransaction` 是局部习惯（P2）

只有 `store.ts`、`assets.ts`、`asset-review.ts`、`bots.ts`、`deliveries.ts` 调用 `tx.ts:11`；`tx.test.ts` 明确嵌套会抛、返回 Promise 也会回滚。回合收尾（写事件 + 取消投递 + 释放）没有显式事务边界。

改法：只给「回合收尾」一条用例加显式事务，并禁止事务体内 await 端口。

## 5. 值得保留 / 不建议动

**值得保留**

- 领域纯净是机械的：`scripts/check-domain-purity.mjs:10` 只放行 `node:crypto`/`node:path`；`check-import-boundaries.mjs:16-36` 里 domain 是空表，读失败会 `failures.push` 而非静默跳过。
- SessionInbox 只合并判断、不合并队列：`packages/domain/src/session-inbox.ts:38-61`，与 ADR 0036「三张表不合并」一致。
- 双能力面一份 schema：`apps/server/src/openapi/routes.ts:224-236`，MCP 元数据不可枚举、不进 `openapi.json`；`resolveMcp` 对 `'auto'` 的非 GET 返回 null。
- 状态回写防旧快照：`packages/storage-sqlite/src/store.ts:318` 用 `last_seq` 决定 status；`:301-305` pinned/interrupted 走专用 UPDATE。
- `apps/server/src/http.ts` 长但薄：大量 `*UseCase` 转发，领域判断不在路由里。

**不建议动**

- 不合并 `message_delivery` / `agent_group_deliveries` / `trigger_run`（ADR 0036 判断正确，收件箱已是合并点）。
- 不改 Workspace 名字，不重做协议兼容层（ADR 0037 已标暂缓）。
- 不拆 `http.ts` 的用例转发——要拆的是 `main.ts` 的装配与定时器。

## 6. 修复进度

§§1–5 是基于 `2885ccf` 的历史评审，不描述当前代码。下表与验收、阿里云状态是 2026-11-21 收尾时的记录，并非本次重新验证。评审结项不等于清空所有建议；仍需确认产品语义或另行排期的条目列在表后。

| 项 | 状态 | 提交 |
| --- | --- | --- |
| 2.1 git 主机规范 IP | 已合入 | `bd1d213` |
| 2.2 fork 越权 | 已合入 | `8d7a127` |
| 3.1/3.2 幂等键与 TTL | 已合入 | `bd1d213` |
| 3.3 404 语义 | 部分覆盖，剩余语义另议 | `8d7a127`（终端握手） |
| 3.4 `decide` 查过期 | 已合入 | `8d7a127` |
| 3.5 投递锁 | 已合入条件认领 | `bd1d213` |
| 3.6 OAuth 缓存键 | 已合入 | `1476fef` |
| 3.7 `scrubCredentials` | 已合入 | `bd1d213` |
| 3.8 Host 必需 | 已合入 | `8d7a127` |
| 4.1 `wireX` 拆分 | 已抽出连接器、预览、工具装配与定时器登记 | `1476fef` |
| 4.2 回合收尾总闸 | 已集中收尾并调整孤儿回收 | `1476fef` |

后续不阻塞本轮结项：

- **§3.3 权限错误语义**：终端握手对无权与不存在统一返回 404。通用路径仍区分不可见资源和可见但无操作权限的资源；继续改之前，需逐入口明确可见性规则，不宜把所有 403 改成 404。
- **§4.4 SQLite 显式清空**：先验证 UI/API 的清空请求是否会被 `COALESCE` 保留旧值，再决定是否增加专用更新；启动迁移另行评估。
- **§4.3、§4.5–4.7**：协议字段演进门禁、幂等元数据语义、前端边界及回合收尾事务边界，均未在本轮宣称完成。§3.1/3.2 的修复不等于 §4.5 的声明审计已完成。

当时报告的收尾验收基线 `cafd249`：架构门禁、后端和 Web 类型检查及 Web 构建均通过；`npm test` 2351 通过、8 跳过、0 失败；`npm run openapi:snapshot` 生成的快照无差异；Playwright `e2e/access.spec.ts` 与 `e2e/ui-interaction.spec.ts` 共 3 项通过。当时报告阿里云运行该提交，健康检查通过；未实测生产登录或新会话首条回复。
