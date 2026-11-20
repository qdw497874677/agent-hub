# 模块化评估（2026-11-21）

本文只回答一个问题：**现在的架构够不够模块化**。结论先给，证据在后；与外部 harness（DeepSeek-Harness）的对照放在 §5（调研完成后补）。

## 1. 结论

分层是**成立**的，边界是**被强制的**，但模块化只做到「包级」，没做到「能力级」：

- 包级：18 个 workspace，依赖方向无环，`domain` 生产代码零 IO，全部经过四道门禁（`scripts/check-{domain-purity,import-boundaries,port-signature,lockfile}.mjs` + selftest）。跨包深路径 import 为 **0**（`from '@agent-hub/x/src/…'` 全仓 0 处）。
- 能力级：**不足**。核心表征是 `packages/domain/src/use-cases/deps.ts` 的 `Deps` 是一个 **34 字段的依赖袋**，127 个用例文件共享它；任何用例在编译期都能摸到任何端口，模块边界只存在于「人读 import」里。
- 表现层：`apps/server/src/openapi/{routes,app}.ts` 各 1.5k 行、`packages/node-gateway/src/worker-link.ts` 1.5k 行、`apps/web/src/shell/api.ts` 1.4k 行，是按协议/按页面切的，不是按能力切的。
- 测试替身：`packages/domain/src/testing/in-memory.ts` 1.4k 行，是 `Deps` 的完整镜像——`Deps` 每加一个字段，这里就要跟着改，说明它是「一个模块」的替身，而不是多个。

一句话：**依赖倒置做得对，模块封装没做够**。

## 2. 度量（本仓，2026-11-21，`1476fef` 之后）

| 指标 | 数值 | 读法 |
| --- | --- | --- |
| workspace 数 | 18（`packages/*`、`packages/adapters/*`、`apps/*`） | 包级切分充足 |
| 源码行数 | ~126k（不含测试） | — |
| 测试文件 / 用例 | 356 / 2334 | 覆盖是资产 |
| `domain/src/ports` 文件 | 75 | 端口细，方向对 |
| `domain/src/use-cases` 文件 | 127 | 用例多，但共享一个 `Deps` |
| `Deps` 字段 | 34 | **最大耦合点** |
| 跨包深路径 import | 0 | 边界没被绕过 |
| `as any` / `@ts-expect-error`（非测试） | 42 | 可接受，集中在 DTO 转换 |
| 最大文件 | `openapi/app.ts` 1545、`openapi/routes.ts` 1488、`worker-link.ts` 1478、`web/shell/api.ts` 1400、`testing/in-memory.ts` 1384、`server-gateway.ts` 1378、`focus.tsx` 1309、`chat-blocks.tsx` 1298、`http.ts` 1278、`asset-review.ts` 1241、`main.ts` 1194 | 前三类是「按协议/传输切」而不是「按能力切」 |

依赖方向（`package.json` 实测）：

```
web ──▶ contract
worker ──▶ adapters(acp|codex|grok|hermes|pi) ──▶ domain
        └▶ node-gateway ──▶ contract ──▶ domain
server ──▶ domain, contract, storage-sqlite, node-gateway, observe,
           connectors(github|feishu|timer), adapters(accounts|assets)
connectors ──▶ domain
storage-sqlite ──▶ domain
```

无环，方向单调：`domain` 不知道任何人；`contract` 只依赖 `domain`；`node-gateway`/`storage`/`connectors`/`adapters` 都是 `domain` 的实现方；两个 app 是组合根。

## 3. 已经做对的三件事（不要动）

1. **领域纯净靠门禁而不是自觉**：`check-domain-purity.mjs` 的 ALLOWED 表为空，`domain` 里出现 `node:`/`fs`/`Date.now()` 直接红；端口签名有 `check-port-signature.mjs`。这比多数同类项目的「约定俗成」强。
2. **能力面只有一份 schema**：REST 与 MCP 共用 `openapi/routes.ts` 的 41 条路由定义、35 个工具由路由元数据生成（`resolveMcp`，且 `mcp` 字段不可枚举，不会漏进 OpenAPI 文档）。这避免了「REST 与人机接口各写一遍」的典型分叉。
3. **组合根已经被压过一次**：`main.ts` 1946 → 1194，`wire-connectors/wire-tools/wire-preview/schedules` 分别持有各自子系统；三处 `(deps as {…})` 断言消掉了。

## 4. 不够模块化的四个点（按收益排序）

### 4.1 `Deps` 是依赖袋，不是模块边界

证据：`packages/domain/src/use-cases/deps.ts` 34 个字段；`in-memory.ts` 1.4k 行一一对应；用例里普遍 `Pick<Deps, 'a'|'b'|'c'>` 手工挑选（说明作者知道该收窄，但语言没帮忙）。

后果：
- 加一个端口，所有用例的「可见依赖集合」同时变大；
- 测试替身只能整包实现，无法按能力给最小 fake；
- 「这个能力依赖哪些外部资源」无法从类型上读出，只能读 import。

改法（低风险，可渐进）：把 `Deps` 拆成**能力模块的 deps 类型**，例如 `SessionDeps`、`AssetDeps`（已存在）、`DeliveryDeps`、`MessagingDeps`，每个模块只暴露自己需要的端口；`Deps` 退化为组合根用的 `Deps = SessionDeps & AssetDeps & …`。已有 `Pick<Deps,…>` 的用例可以原地换成对应模块类型，不需要改调用方。

### 4.2 协议层按「协议」切，没按「能力」切

`openapi/{routes,app}.ts` 各 1.5k 行，41 条路由 + 41 个 handler 在同一文件；`worker-link.ts` 1.5k 行同时管握手、帧路由、会话生命周期、资产下发、终端/预览通道。

后果：改一个能力（例如工作空间）要在大文件里找 4 个不相邻的位置；code review 的 diff 噪声大；文件级冲突概率高（今天 merge 冲突就出现过在同文件）。

改法：`openapi/` 按模块拆 `workspaces.ts`/`assets.ts`/`sessions.ts`…，每个文件导出 `routes` 片段与 `handlers`，`app.ts` 只做注册；`worker-link.ts` 拆 `link-transport.ts`（socket/重连/凭据）、`link-frames.ts`（帧分发）、`link-sessions.ts`（生命周期/资产）、`link-channels.ts`（终端/预览）。parity 测试已经保证工具清单不变，拆分是纯搬运。

### 4.3 Web 的 API 客户端是「一个文件装下整个后端」

`apps/web/src/shell/api.ts` 1400 行、N 个 `xxxApi` 命名空间。它没有类型安全问题（类型来自 contract），但它是**前端唯一的耦合点**：任何后端能力变更都触碰同一文件。

改法：按 surface 拆 `api/{sessions,assets,workspaces,providers,…}.ts`，`shell/api.ts` 变成 re-export barrel（保留现有 import 路径，零迁移成本）。

### 4.4 测试替身与生产实现同构

`testing/in-memory.ts` 1.4k 行镜像 `Deps`。它保证了用例测试不碰 IO，但也意味着**替身永远是全量的**，无法表达「这个用例只需要 sessions 和 gateway」。

改法：随 4.1 一起拆，按模块提供 `fakeSessions()`/`fakeAssets()`…，`inMemoryDeps()` 组合它们。这是 4.1 的自然副产物，不需要单独排期。

## 5. 与 DeepSeek-Harness 的对照

（待调研结果补入：目录分层、核心抽象、扩展点、强制手段、可借鉴/不照搬。）

## 6. 建议的落地顺序

1. **4.1 + 4.4（一起做）**：`Deps` 收敛成模块 deps，`in-memory` 跟着拆。纯类型搬运 + 测试重组，行为零变化，用现有 2334 用例当回归网。
2. **4.2**：`openapi` 按模块拆文件（parity 测试护住对外契约），`worker-link` 按职责拆（协议帧不变，不需要升版）。
3. **4.3**：`shell/api.ts` 拆 surface + barrel，前端一次性机械迁移。
4. 不建议做：把 18 个包再合并、把 `http.ts` 拆成微服务、为「模块化」引入 DI 容器（`Deps` 的显式组合根已经比容器更好读）。
