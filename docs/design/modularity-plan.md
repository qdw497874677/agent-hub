# 模块化优化方案（v2，2026-11-21）

v1 被评审否掉了阶段 A 与阶段 E（见 §9 评审记录）。v2 只保留**零行为、可回滚、收益明确**的三件事，并把 v1 里的事实错误改掉。

基线：`1476fef`，`npm test` 2334 用例 / 2326 通过 / 8 skipped / 0 失败；`check`/`typecheck`/`typecheck:web`/`build` 0。

## 0. 验收标准（v2）

| 指标 | 现状 | 目标 | 备注 |
| --- | --- | --- | --- |
| `apps/server/src/openapi/app.ts` | 1545 | < 700 | **不是 <300**：`installOpenApi` 的鉴权/限流/`openStreams` 前导必须收成显式 `V1Runtime` 才能搬 handler，剩 300 行不现实 |
| `apps/server/src/openapi/routes.ts` | 1488 | **保持为 barrel**（< 120），分片在 `routes/*.ts` | parity 测试从 `./openapi/routes.ts` import，barrel 不能删 |
| `apps/server/src/openapi/handlers/*.ts` | — | 每个 < 450 | 新增目录 |
| `packages/node-gateway/src/worker-link.ts` | 1478 | < 500（门面） | 其余拆 `link/`，共享同一个可变 ctx |
| `apps/web/src/shell/api.ts` | 1400 | < 200（barrel） | 其余 `shell/api/*.ts` |
| `packages/domain/src/testing/in-memory.ts` | 1384 | < 200（barrel） | 其余 `testing/fakes/*.ts`，导出集合不变 |
| `Deps` / `Pick<Deps,…>` | 34 字段 / 158 处 | **不动** | 评审：按目录并集只会造新胖类型 |
| 对外契约 | — | 路由 41 / 工具 35 / 协议 v7 / DTO 不变 | `openapi:snapshot` 必须无 diff |
| 测试 | 2334 | ≥ 2334，0 失败 | 断言一行不改 |

## 1. 阶段 A（in-memory 拆分）

**不做** v1 的 `Deps = SessionDeps & AssetDeps & …`。理由（评审原文要点）：

- `AssetDeps` 是**故意**不进 `Deps` 的限界上下文（`packages/domain/src/use-cases/assets.ts:48-74` 有注释）。它的 `projects` 只收窄到 `byId`，交叉进 `Deps` 会把组合根上的 `ProjectRepository` 收成 `{byId}`，`apps/server/src/main.ts:176` 直接红。
- 交叉类型允许同一字段出现在多个成员里，只要类型兼容就静默合并——「新增端口只加到一个能力」编译期发现不了；做「两两不相交」门禁又会把 `now`/`access`/`sessions`/`projects`/`tasks`/`gateway`/`workspaces` 全部判红。
- 按目录并集必然变胖：`delivery.ts:15` 已是 14 键；`sessions.ts:74` 单签名 14 键，同文件另有 2 键签名，并集会把 2 键抬到 14。

保留现状规则：`Deps` 只在组合根与 5 处测试出现；`Pick<Deps,…>` 就地保留；**只有同一组键在 ≥3 个签名里原样重复**时才起别名（`DeliveryDeps`/`WorkspaceGroupDeps`/`ProviderDeps`/`AccountDeps` 已存在，继续用）。

### A1 实际动作：`testing/in-memory.ts` → barrel

拆法按**端口/已有工厂**，不按能力 deps：

```
packages/domain/src/testing/
  in-memory.ts      # barrel：原样 re-export inMemoryDeps / InMemoryWorld / InMemoryDeps / FakeGit …
  fakes/world.ts    # InMemoryWorld 组装 + inMemoryDeps(overrides)
  fakes/repos.ts    # projects/tasks/sessions/workspaces/… 各仓储
  fakes/runtime.ts  # fakeHosting / immediateQueue / FakeGateway / FakeGit / dispatched 记录
  fakes/access.ts   # inMemoryAccess / inMemoryApiTokens / inMemoryAssetReviewDeps / inMemoryDeliveries
```

约束：
- `inMemoryDeps(overrides: Partial<Deps> = {})` 的覆盖是**单端口**，签名一字不改。
- `InMemoryWorld` 上的额外字段（`dispatched`/`frames`/`agents`/`workers`/`git`）归属 `fakes/runtime.ts`，断言路径不变。
- barrel 导出集合与类型签名字节级不变；调用方全是深路径（`directories.test.ts:29`、`tools/files-tools.test.ts:89`、`packages/storage-sqlite/src/connectors.test.ts:18` 等），靠 barrel 保持零 import 变更。
- 不新增假件体系。

## 2. 阶段 B：openapi 拆文件（routes 与 handlers 同一 lane、串行）

先纠正 v1 的三处事实错误：

1. 没有 `RouteTable`；`routes.ts:493-1475` 是 `as const`。拆片后汇总处**不能**丢 `as const` 带来的字面量类型（handler 侧的 `keyof typeof routes` 依赖它）。
2. `route()`（`routes.ts:248-261`）用 `Object.defineProperty` 把 `mcp` 设为不可枚举；**可以 spread 路由表 map**（`{ ...sessions, ...tasks }`），**不能 spread 单条 route**（`getRoutingPath` 丢失、`mcp` 漏进 `docs/openapi/v1.json`）。
3. 文件末尾 `:1482-1488` 就地改 `entry.description` 的 annotate 循环依赖同一对象引用，必须留在组装后的唯一一处。

### B1 routes 分片

```
apps/server/src/openapi/routes.ts      # barrel + route()/resolveMcp()/MODULE_OF_TAG/NEED_OF_TAG（单点）
apps/server/src/openapi/routes/
  sessions.ts tasks.ts projects.ts workspaces.ts assets.ts
  providers.ts workers.ts tokens.ts misc.ts
```

每片导出 `const x = { … } as const` 的路由 map；`routes.ts` 里 `export const routes = { ...sessions, ...tasks, … } as const;`，随后原地跑 annotate 循环。`openapi-mcp-parity.test.ts` 的 import 与 41/35 计数不变。

### B2 handlers 分片（依赖 B1）

先把 `installOpenApi` 的前导收成显式运行时对象：

```ts
// apps/server/src/openapi/context.ts
export interface V1Runtime {
  deps: Deps;
  assetReview?: …; components?: …; git?: …; files?: …; messaging?: …;
  principal(c): Promise<Principal>;       // 原闭包里的鉴权
  viaNote(c): …; projectLimited(...): …;  // 原闭包里的辅助
  limiters: { … };                        // 三套 rate limiter
  openStreams: …;                         // 原闭包里的活跃流表
}
```

然后把 `app.ts:233-1545` 的 `on(routes.x)` 搬到 `handlers/<module>.ts` 的 `installX(app, rt: V1Runtime)`，`app.ts` 只保留：构造 `V1Runtime`、按顺序 `installX`。

约束：鉴权、限流、审计、`openStreams` 的调用顺序与参数一字不改；handler 里不得复制前导逻辑。

## 3. 阶段 C：`worker-link.ts` 拆「共享 ctx 的内部模块」

**不是**四个无共享纯函数。`handle()`（`worker-link.ts:1052`）失败分支会 `sessions.delete`/`workspaces.delete`/`forget`/`closeTerminals` 并回 `ended`；`run()`（`:1070`）用 `starting.get` 串行化 `start_session` 与其后续帧；`prompt` 有 `deliveryId` 去重（`seenDeliveries` 上限 1000）。任何「只认协议不碰语义」的切法都会丢帧或改顺序。

```
packages/node-gateway/src/link/
  ctx.ts        # 可变 LinkCtx：socket、credential、sessions/workspaces Map、starting、seenDeliveries、log
  transport.ts  # connect/reconnect/backoff/credential_rotate/heartbeat/编解码
  frames.ts     # handle()：分发，调用下两者；失败清理仍在本文件（保持在同一处）
  sessions.ts   # start/dispose/prompt/interrupt/compact/approval/set_option + 资产同步/视图
  channels.ts   # 终端与预览通道
  link.ts       # WorkerLink 门面 + connectWorkerLink（公开面不变）
```

公开面只有 `connectWorkerLink`（`:219`）与 `WorkerLink`（`:184-208`），两者签名不变；`server-gateway.ts` 对它们零引用，不需要改。提交前必须跑：`gateway`、`inventory`、`worker-update`、`mcp-relay`、`harness-readiness`、`worker-assets`。

## 4. 阶段 D：Web API 客户端拆 surface

`apps/web/src/shell/api.ts` → `apps/web/src/shell/api/{sessions,tasks,projects,workspaces,assets,providers,workers,tokens,messages,misc}.ts`；`shell/api.ts` 保留 barrel，所有既有导出名与类型（`ProviderModelDto` 等）原样 re-export。无运行时聚合逻辑。可与 B 并行。

## 5. 阶段 E：不做

v1 §4.5 三条全部撤回：

- **产物式端口图门禁**：消费方半边可静态枚举，实现方半边没有静态规则（全仓端口实现基本不写 `implements`；`projects`/`tasks`/`sessions` 同名属性到处是；还有 `createContextService`/`createWorkspaceFilesService`/`createGitWorkflowService` 这类不经 `Deps` 的第二套装配）。要消假阴性只能新增 `// port: X` 注释契约——为一次零行为重构引入新契约不划算。若想要图，做成 `docs/` 下人工查阅的生成物，**不进 `npm run check`**。
- **provider 注册期占用**：slug 唯一性已在 `createProvider`（`packages/domain/src/providers.ts:68`）与 `updateProvider`（`:91-92`）一处完成；改成「全有或全无」是行为变化，违反零行为目标。
- **能力自述（`enforcement`/`denialSignatures`）**：那是未来协议字段，本次协议 v7 是不变项。

## 6. 顺序、并行与提交

| 顺序 | 阶段 | lane | 共享写域 |
| --- | --- | --- | --- |
| 1 | A（in-memory barrel） | fixer 1 | `packages/domain/src/testing/**` |
| 1 | D（web api 拆） | fixer 2 | `apps/web/src/shell/api*` |
| 1 | B（openapi，routes→handlers 串行） | fixer 3 | `apps/server/src/openapi/**` |
| 1 | C（worker-link） | fixer 4 | `packages/node-gateway/src/{worker-link.ts,link/**}` |

四者写域不重叠，可并行。每条 lane 只跑自己包的测试，**不跑全量 `npm test`**（避免抢 CPU 造成既有噪声），全量由我在合并后跑一次。

提交粒度：
- A、D、C 各一提交；
- B 允许两提交（routes 分片 / handlers 分片），**中间不插别的提交**，提交前跑 `openapi-mcp-parity` + `openapi:snapshot`。

回滚：全部是纯重构、无迁移、无数据写入，`git revert` 对应提交即可。C 若提交后才发现丢帧，回滚后补测试，不在拆分结果上打补丁。

## 7. 明确不做

- 不拆 `Deps`、不做能力 deps、不做端口不相交门禁。
- 不引入 DI 容器、不引入 profile/bundle/patch 组合系统、不扩到 60 包、不拆 tool/executor。
- 不动协议版本、不改 HTTP 路径 / MCP 工具名 / DTO 字段、不顺手改业务逻辑。

## 8. 验证口径

每阶段：该包 `tsc`/单测 → 合并后整仓 `check` → `typecheck` → `typecheck:web` → `npm test`（≥2334/0 失败）→ `build` → `openapi:snapshot` 无 diff → 触到 web 的阶段按 AGENTS.md §4 跑相关 Playwright（`access`/`ui-interaction`，独立 `E2E_PORT` + 新 `E2E_DATA_DIR`）。

## 9. 评审记录（v1 → v2）

评审（`ses_e061e626effe7r0381xSiMgkT9`）结论：
1. 阶段 A 按目录并集 → **不做**：`AssetDeps` 是限界上下文，交叉进 `Deps` 会让 `main.ts:176` 与所有 `inMemoryDeps({ now })` 同时红；`Pick` 就地保留，只保留既有的窄别名。
2. 阶段 B 可做，但必须纠正：无 `RouteTable`（`as const`）、`route()` 的不可枚举 `mcp` 不能 spread 单条、annotate 循环必须单点、`routes.ts` 必须留 barrel（parity 测试 import 它）、`app.ts <300` 不现实（前导闭包共享鉴权/限流/流表，要先抽 `V1Runtime`），realistic：`app.ts <700`。
3. 阶段 C 可做，但拆的是「共享可变 ctx 的内部模块」，不是四个纯函数；失败清理与 `starting` 串行必须留在同一处；单独一提交。
4. 阶段 D 可与 B 并行。
5. 阶段 E 三条 → **不做**（理由见 §5）。
6. `in-memory.ts` 拆分低风险，但必须留 barrel 让深路径 import 与断言零变更；按端口/已有工厂拆，不按能力 deps。
