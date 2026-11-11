# 会话环境刷新（Session Environment Refresh）

> 状态：P0 已实现（环境 revision + 下一轮自动重托管）；P1/P2 待做  
> 目标版本：P0（资产/MCP 变更后下一轮自动生效）  
> 相关：`docs/design/asset-hub.md`、`docs/design/acp-runtime-codec.md`、`docs/adr/0034-subagent-display.md`

## 1. 问题

会话启动时，Hub 把“这次会话能用什么”一次性交给 Worker/Agent：

- 技能、指令：`start_session.assetIds` / Worker 资产清单；
- 外部 MCP：`start_session.mcp` → ACP `session/new|load` 的 `mcpServers`；
- Hub 工具：会话级 MCP 入口 + 工具令牌；
- 运行时本身：Worker 上已经启动的 harness 进程。

这些入口都只在**会话启动**时下发。之后：

- 安装/升级/删除 MCP 资产；
- 改技能或指令；
- 项目开关变化；
- Worker 资产同步状态变化；

当前运行中的 Agent 进程不会重新读取。用户必须新建会话，或者手动让会话重新托管，才会用到新能力。

这不是“MCP 工具列表”问题：Hub 的 `tools/list` 本来就是按请求动态算的；真正的问题是 **Agent 客户端的 MCP 连接、技能启动参数和系统提示在进程启动时已经固定**。

## 2. 目标与非目标

### 做

1. 会话记录“启动时实际使用的环境版本”（opaque revision）。
2. 发消息前重新计算当前 revision；发生变化且没有回合在跑时，自动重新托管会话。
3. 重新托管使用 `resume`，保留 Agent 会话文件和 Hub journal。
4. 任何 runtime 都适用，不依赖 ACP 扩展或 MCP 推送。
5. 失败时 fail-open：资产计划算不出来就继续用旧环境，不阻塞用户发言。
6. 给 UI/日志一个明确的“下一轮生效”状态。

### 不做

- 不做运行中 MCP `tools/list_changed` 推送。
- 不做进程内替换 `mcpServers` / 技能目录。
- 不自动升级资产版本；仍然由用户确认升级。
- 不处理 runtime 二进制升级（Worker 更新仍走现有 agent update）。
- 不在一个回合进行中强杀进程；只在下一次投递前刷新。

## 3. 核心概念

### Session Environment

一条会话在某个 Worker、某个项目作用域下，**实际可用的能力集合**：

- 生效资产：`sessionAssetPlan()` 返回的 `entries`（技能、指令、MCP）；
- 实际启动的 MCP：`sessionMcpLaunch()` 返回的 `launch`（缺密钥/启动失败的只记 `skipped`）；
- 作用域：项目、Worker、viewer（个人/团队可见性）；
- 不包含：模型、Agent、思考强度、连线、权限、上下文策略。这些是热更新或调用时动态数据，不属于环境。

### Environment Revision

一个稳定的内容哈希，只描述“环境是否变了”，不暴露密钥：

```text
sha256(canonicalJson({
  projectId,
  workerId,
  assets: entries
    .map(e => [e.assetId, e.kind, e.name, e.digest, e.scope])
    .sort(),
  mcp: launch
    .map(l => [l.name, l.transport, l.command ?? '', l.args ?? [],
               hashOfEnvKeysAndValues(l.env)])
    .sort(),
  skipped: skipped
    .map(s => [s.name, s.reason])
    .sort()
}))
```

约束：

- 所有数组先排序，保证同样内容得到同样 revision。
- `env` 只用于 stdio MCP；值先做 SHA-256 再进整体哈希，不把明文密钥写进 revision 或日志。
- **不包含**工具令牌、模型、Agent option、会话标题、时间戳；否则每次启动都会“变化”，导致无限重托管。
- 资产 `digest` 来自现有钉住版本/Worker 落地版本；MCP 只算真正 `launch` 的，缺密钥的通过 `skipped` 参与 revision。

## 4. 分层与模块边界

目标是把“环境是什么”和“什么时候重托管”拆开。

### domain

新增端口：

```ts
// packages/domain/src/ports/session-environment.ts
export interface SessionEnvironmentPort {
  /** 当前应当使用的环境 revision；null = 这个部署没有环境能力/无法计算。 */
  revision(session: Session): Promise<string | null>;
}
```

`Deps` 增加：

```ts
readonly environment?: SessionEnvironmentPort;
```

`Session` 增加：

```ts
readonly environmentRevision?: string | null;
```

`ensureHosted()` 只依赖端口，不 import 资产/MCP/HTTP：

```ts
const current = await deps.environment?.revision(session);
const stale =
  current !== null &&
  session.environmentRevision != null &&
  current !== session.environmentRevision;

if (deps.hosting.has(session.id)) {
  const grant = ...;
  if (!stale && grant !== null) return ok(undefined);
  deps.hosting.drop(session.id); // Worker 收到同 id 的新 start 会先 dispose 旧进程
}
```

这样 conversation、delivery、change-option 都不需要知道资产细节。

### server

新增 `apps/server/src/session-environment.ts`，把现有的 `withSessionAssets` 逻辑收进来：

```ts
export interface PreparedStart {
  command: WorkerCommand;
  revision: string | null;
}

export interface SessionEnvironment {
  /** 给 Worker 的 start_session 填 assetIds/mcp；同时算 revision。 */
  prepare(command: Extract<WorkerCommand, { kind: 'start_session' }>): Promise<PreparedStart>;
  /** 给 ensureHosted 比较用；只算 revision，不拉密钥明文。 */
  revision(session: Session): Promise<string | null>;
}
```

- `prepare` 负责 `sessionAssetPlan` + `sessionMcpLaunch` + `recordSessionAssets`；
- `revision` 复用同一套 plan/launch 计算，只返回哈希；
- 失败只记日志并返回 `revision: null`，不阻塞启动。

`apps/server/src/main.ts` 的 `deps.gateway.dispatch`：

```ts
const prepared = await environment.prepare(command);
const sent = await serverGateway.gateway.dispatch(prepared.command);
if (sent.ok && command.kind === 'start_session' && prepared.revision) {
  const session = await store.sessions.byId(command.sessionId);
  if (session) {
    await store.sessions.save({
      ...session,
      environmentRevision: prepared.revision,
      updatedAt: Date.now()
    });
  }
}
```

关键：**revision 只在 dispatch 成功后落库**，避免启动失败却把环境标记成“已应用”。

### storage

- `sessions` 表增加 `environment_revision TEXT`。
- `store.ts` 老库补列，映射到 `Session.environmentRevision`。
- 旧会话为 `NULL`：不因为 `NULL` 强制重托管；下一次成功启动时记录。这样不会在升级后把全站旧会话同时踢一遍。

### web

P0 先不做强制 UI；P0.4 可选增加只读状态：

```text
GET /api/sessions/:id/environment
{ revision: string | null, stale: boolean }
```

`stale` 是服务端实时算出的 `current !== session.environmentRevision`。  
Focus 页只在 stale 时显示一行：

> 工具/技能有更新，下一轮消息会自动应用。

不要把 revision 本身展示给用户。

## 5. 流程

### 5.1 新会话 / 重新托管

```text
derive/ensureHosted
  → startCommand()
  → gateway.dispatch
      → environment.prepare(command)
          → sessionAssetPlan()
          → sessionMcpLaunch()
          → recordSessionAssets()
      → Worker start_session
      → dispatch ok
      → store.sessions.save({ environmentRevision })
```

### 5.2 用户发消息

```text
promptSession
  → ensureHosted(session)
      → environment.revision(session)
      → 如果 hosted 且 revision 变化：
           hosting.drop(session.id)
      → 如果未 hosted：
           dispatch start_session(resume)
           dispatch 成功后记录 revision
  → dispatch prompt
```

### 5.3 回合进行中

`ensureHosted` 只在投递前调用。当前回合已经在跑时，新的 prompt 先进入 delivery queue；等回合结束、队列投递下一条时才比较 revision。因此不会在模型输出中途杀进程。

### 5.4 失败与降级

| 情况 | 行为 |
| --- | --- |
| `environment` 未注入 | 保持旧行为，不刷新 |
| revision 算不出来 | 记日志，按旧环境继续，不阻塞 prompt |
| `environmentRevision` 为 null（旧会话） | 不强制刷新；下次成功启动后记录 |
| 会话没有有效工具授权 | 沿用现有逻辑：drop + 重新托管换 token |
| 当前 runtime 不支持 resume | 现有 `start_session` 失败路径；不新增特殊分支 |
| 新环境启动失败 | 不覆盖旧 revision；用户可重试；日志保留失败原因 |

## 6. 为什么这样收敛

- **一个判断点**：`ensureHosted` 只问 `environment.revision()`。
- **一个计算点**：server 的 `SessionEnvironment` 同时服务 `prepare` 和 `revision`，资产规则不会分叉。
- **一个持久字段**：`environmentRevision` 只存 opaque hash，不存资产明细。
- **零 runtime 分支**：不判断 OpenCode/Pi/Hermes，也不碰 ACP codec。
- **零 MCP 协议改动**：不依赖 `list_changed`，不让 Hub MCP 变成有状态服务。
- **可独立测试**：domain 用 fake environment 测刷新决策；server 测 revision 稳定性；E2E 测“安装资产 → 下一轮重托管”。

## 7. 实施阶段

### P0.1 领域与存储

- `Session.environmentRevision`
- `SessionEnvironmentPort`
- `Deps.environment?`
- `ensureHosted` 比较 + drop
- SQLite 列/迁移/映射
- 单测：revision 相同不重托管；变化且 hosted 时 drop；旧会话 null 不触发；无端口保持旧行为

### P0.2 服务端环境适配器

- 抽出 `apps/server/src/session-environment.ts`
- `withSessionAssets` 改为调用 `environment.prepare`
- dispatch 成功后写 revision
- 单测：同一资产计划 revision 稳定；资产/secret/launch 变化 revision 变化；secret 值不进入日志

### P0.3 刷新链路

- `ensureHosted` 注入 `environment`
- 验证 `hosting.drop` 后 Worker 同 id `start_session` 会 dispose 旧进程（现有 `worker-link.startSession` 已做）
- 回归：token 过期重托管、模型切换、普通 prompt、delivery queue

### P0.4 状态与观测

- 可选 `GET /api/sessions/:id/environment`
- Focus 显示“下一轮生效”
- 日志：`session <id> environment changed, rehosting`

### P0.5 验证

- domain 单测
- server revision 单测
- E2E：
  1. 建会话；
  2. 安装/启用一个新 MCP 资产（或改技能版本）；
  3. 发下一句；
  4. 断言发生第二次 `start_session`，且新会话仍用原 `agentSessionRef`/cursor；
  5. 若用 fake MCP，断言新工具在下一轮可见。
- 全量 `check` / `typecheck` / `typecheck:web` / 单测 / 关键 E2E。

## 8. 后续（不在 P0）

### P1 工具目录缓存

`gateway.list(grant)` 目前每条 MCP 消息算一次。可以按 `grant.id + catalogRevision` 缓存，减少外部 `listTools()` 延迟；不改变“何时重托管”的语义。

### P1 Pi shim 动态资产

`apps/worker/src/mcp-shim.ts` 每次 `tools/list` 重新读版本化资产文件，动态增删外部 MCP 子进程；支持时发 `tools/list_changed`。只解决 Pi，不解决 OpenCode 原生 MCP。

### P1 能力位

新增类似 `tools.hot_reload` / `assets.hot_reload` 的能力三态，UI 明确“实时更新 / 下一轮生效 / 需新会话”。

### P2 持久 MCP + 推送

把 Hub MCP 从“每条消息一个临时 Server”改为按授权保持长连接，声明 `tools.listChanged`，在工具变化时 `sendToolListChanged()`。需要重新设计连接生命周期与鉴权，按真实需求再做。

## 9. 风险

1. **rehost 频率**：如果 revision 包含 token/时间等易变值，会每轮重托管。必须只哈希环境内容。
2. **旧会话**：`environmentRevision = NULL` 不主动刷新，升级后不会立刻应用新资产；这是有意的稳定性取舍。
3. **secret 轮换**：只哈希 env 值摘要，能触发刷新；不要把明文写日志。
4. **运行中变更**：只在下一次投递前应用，用户看到的是“下一轮生效”，不是实时。
5. **Worker 旧版本**：旧 Worker 不认新的 `start_session` 字段时，环境刷新仍可用；新增字段必须是可选的。
