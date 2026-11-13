# agent 原子抽象优化方案

> 状态：设计稿已定稿（2026-11-13）。7 个关键决策已拍板，见 §0。目标是把「同一个概念四种叫法」「启动配置四套表达」「启动一条会话要拼五处」三件事收敛掉，不动产品形态与协议。
> 前置阅读：`docs/design/front-end-layering.md`（前端分层）、`docs/adr/0001`（四聚合）、`docs/adr/0007`（选项来自 agent）。

## 0. 决策记录（2026-11-13）

| # | 议题 | 决定 |
| --- | --- | --- |
| 1 | `AgentRef` 里表示 runtime 的字段名 | **`runtime`**（不叫 `agentId`；`Session.agentId` 作为已存在的快照字段保留，读的时候由 `sessionRef()` 映射） |
| 2 | `AgentRef` 是否内嵌 | **直接内嵌**：`AgentProfile.ref`、`PersistentAgent.ref`，不再保留扁平的 `agentId/model/options` |
| 3 | `Session` 是否加快照字段 | **不加**，只提供纯函数 `sessionRef(session)` |
| 4 | `buildEnvironment` 归属 | **端口在 domain、实现在 server**（`EnvironmentPlanner`），domain 保持零外部依赖 |
| 5 | `rewind` 归类 | **算 `startSession` 的一种 origin**（它本来就是 fork 新会话 + 摘要交接） |
| 6 | `role:` → `bot:` 历史键 | **一次性迁移脚本**（上下文策略 / 群会话绑定 / 派工记录三处），迁移前必须备份 `hub.db` |
| 7 | bot 是否升级为一等聚合 | **留到 C3 再做**；本轮只收敛启动配置与入口 |

## 1. 现状与问题

底座是对的：会话是唯一持久单元、能力项由 runtime 上报、权限只有一个判定点。问题集中在内部表达：

| # | 问题 | 证据 |
| --- | --- | --- |
| 1 | 一个概念四个词：runtime 叫 agent、项目成员叫 bot、存储字段叫 role、类型叫 `AgentRole`（已标 `@deprecated`） | `packages/domain/src/agent.ts:13`、`packages/domain/src/messaging.ts:99`、`packages/domain/src/use-cases/groups.ts:61` |
| 2 | 启动配置四处表达、三档校验 | `agent-profile.ts:10`（`cleanOptions`）、`messaging.ts:180`（有 spec 校验）、`session.ts`（`withOptions` 不校验）、`use-cases/sessions.ts:53-61` |
| 3 | 没有统一「启动会话」入口 | `deriveSession`（`sessions.ts:47`）、`startSavedSession`（`:126`）、`fork`（`:166`）、`continueElsewhere`（`continue-elsewhere.ts:43`）、`rewind`（`rewind.ts:14`）、`openRoleSession`（`apps/server/src/role-session.ts:37`）各拼一次 |
| 4 | 身份三套并存 | `createdBy`（归属）/`onBehalfOf`（链头人）/`actor`（审批人）+ bot 的 `ApiToken` |

## 2. 目标与非目标

**目标**
- 一个值对象表达「用哪个 runtime、哪个模型、哪些选项」：`AgentRef`。
- 一处校验：所有入口（profile / bot / 派生命令）走同一个函数，错误文案一致。
- 一个入口启动会话：derive / fork / resume / continue-elsewhere / rewind 都是它的 `origin` 变体。
- 命名在 domain 内一致：`bot` 表示项目内成员，`runtime` 表示 opencode/pi/grok/hermes，`role` 只属于团队 RBAC。

**非目标**
- 不改 worker 协议（`PROTOCOL_VERSION` 保持 2）、不改数据库表结构（P1/P3 零迁移）。
- 不改产品形态与导航（已由 `front-end-layering.md` 负责）。
- 不合并 `AgentProfile`（属人）与 `PersistentAgent`（属项目）两个资源——它们归属不同，只共享 `AgentRef`。

## 3. P1 · 引入 `AgentRef`（收益最大，风险最低）

### 3.1 形状

```ts
// packages/domain/src/agent-ref.ts
export interface AgentRef {
  readonly runtime: string;       // opencode / pi / grok / hermes —— 代码里常叫 agentId，对外统一叫 runtime
  readonly model: string;         // '' = runtime 默认
  readonly options: Readonly<Record<string, string | boolean>>;
}

export const AGENT_REF_OPTION_KEY = /^[a-z][a-z0-9_.-]{0,40}$/;
export const AGENT_REF_OPTIONS_MAX = 16;
export const AGENT_REF_OPTION_VALUE_MAX = 200;

/** 唯一校验点：形状 + 条数 + 键名；spec 校验是可选参数（见 3.3）。 */
export function validateAgentRef(
  input: { runtime: string; model?: string; options?: Record<string, string | boolean> },
  specs?: readonly RuntimeOption[]
): Result<AgentRef, DomainError>;

/** 覆盖：后者赢。用于 profile 打底 + command 覆盖。 */
export function mergeAgentRef(base: AgentRef, override: Partial<AgentRef>): AgentRef;
```

### 3.2 迁移步骤（每步独立提交、独立验证）

1. 新增 `agent-ref.ts` + 单测（键形状、条数上限、值长度、`mergeAgentRef`、`specs` 缺省、`sessionRef()`）。
2. `AgentProfile` 改为 `ref: AgentRef` **内嵌**；存储层保持 `agent_id`/`model`/`options` 三列不动，读写时在 domain 组装/拆开（零迁移）。
3. `PersistentAgent` 同样内嵌 `ref`；删除 `persistentAgentOptionsProblem`/`persistentAgentOptionsSpecProblem`，改由 `validateAgentRef`（可带 `specs`）承担。
4. `DeriveCommand` 改为 `ref?: AgentRef`，`agentId`/`model`/`options` 三个旧字段保留一个版本并标 `@deprecated`，入口处归一成 `ref`（HTTP/工具调用点逐步迁移）。
5. `Session` 不动字段；新增 `sessionRef(session)` 纯函数，调用方不再手拼 `{agentId, model, options}`。

### 3.3 校验策略（明确「什么时候知道键存在」）

- **保存时**（profile / bot）：传 `specs` = 该项目内同 agent 已上报过的 `optionSpec` 去重集；有 spec 就校验键与候选值，没有就只校验形状（今天的 bot 行为）。
- **启动时**：`acp-runtime.ts:486` 的「未知键 warn 后继续、非法值失败」保持不变；`pi-runtime.ts` 同样。
- **不允许**用静态 descriptor 做保存期校验：`adapters/acp/src/adapter.ts:91-98` 的静态 descriptor 里 `options: []`，会把合法选项全丢掉。

### 3.4 验收

- `npm test` 全绿，新增用例覆盖：profile 与 bot 用同一份非法选项，报同一句错；`mergeAgentRef` 的覆盖顺序等于今天的 `{...profile.options, ...command.options}`。
- 冒烟：给 bot 配 `effort`，新会话 `option_spec` 里 `effort` 值等于配置值。

## 4. P2 · 命名收敛（分两步，第二步才碰持久数据）

### 4.1 第一步：类型与函数（低风险）

- 删 `AgentRole`（`messaging.ts`，已 `@deprecated`），统一为 `Bot`；`PersistentAgent` 作为别名保留一个版本，之后删除。
- `groups.ts:59-61`、`messaging.ts:47,98`、`messaging.ts:322` 的 `role`/`roles` 参数改名 `bot`/`bots`（纯重命名，`saveConfig` 的 HTTP body 字段 `roles` 暂不改，避免破坏已发布客户端）。
- 团队 RBAC 的 `Role`/`CustomRole` 保持不动；在 `messaging.ts` 顶部注释写明「本文件的 role 一律指 bot」。

### 4.2 第二步：地址前缀与持久键（一次性迁移脚本）

- 涉及三处持久键：上下文策略 `packages/domain/src/ports/context-settings.ts:3`（`'role:<projectId>:<role>'`）、群会话绑定 `group-store.ts:23-27`、派工记录 `message-store.ts:27`。
- 迁移方式（已定）：新增 `scripts/migrate-role-to-bot.mjs`——只读遍历三处键，事务内写 `bot:` 版本、删 `role:` 版本；支持 `--dry-run` 与 `--report`，跑前强制 `hub backup`（脚本自己检查最近快照是否在 10 分钟内）。
- 代码侧同时**读双格式**一个版本（迁移脚本失败时不至于全挂），迁移验证通过后保留双读、不删。
- 执行窗口：迁移脚本只在部署后手动跑一次，不挂启动钩子。

### 4.3 验收

- `grep -rn "AgentRole" packages apps` 零命中；`check` 通过（domain 纯净性不受影响）。
- 读双格式的兼容用例：旧 `role:` 键仍能命中；新写入为 `bot:`。

## 5. P3 · 统一启动入口 `startSession`

### 5.1 目标形状

```ts
// packages/domain/src/use-cases/start-session.ts
export type SessionOrigin =
  | { kind: 'derive'; taskId: TaskId; ref: AgentRef; workspaceId?: string | null; requires?: readonly string[] }
  | { kind: 'resume'; sessionId: SessionId }
  | { kind: 'fork'; sessionId: SessionId; ref?: Partial<AgentRef> }
  | { kind: 'rewind'; sessionId: SessionId; entryIndex: number }
  | { kind: 'continue'; sessionId: SessionId; target: ContinueTarget };

export async function startSessionUseCase(deps: StartDeps, input: {
  origin: SessionOrigin;
  actor: Subject;
  createdBy?: string | null;
  onBuilt?: (plan: StartPlan) => Promise<void>;   // 连接器/群聊的 saveSpawn 挂这里
}): Promise<Result<StartResult, DomainError>>;

interface StartPlan {
  session: Session;
  ref: AgentRef;
  workspace: Workspace | null;
  assets: readonly AssetDto[];         // session-environment.prepare 的结果
  mcp: McpPlan;
  context: ContextPlan;
  environmentRevision: string;
}
```

要点：**build 阶段在前，spawn 在后**。`environmentRevision` 由 build 阶段算出来（今天它散在 `apps/server/src/session-environment.ts:91` 与 `hosting.ts`），`StartResult` 直接带回，`ensureHosted` 不再重算。

### 5.2 迁移步骤

1. 抽 `buildEnvironment(deps, session, ref)`：把资产下发、MCP 规划、上下文策略合并成一次纯计算，返回 `StartPlan` 的四个字段；先让 `apps/server/src/session-environment.ts` 调它（行为不变的纯重构）。
2. 新增 `startSessionUseCase`，`derive` 先接入，内部把 `deriveSessionUseCase` 的实现挪进去（旧函数变成薄壳，签名不变）。
3. `fork`/`rewind`/`continue-elsewhere` 改为调它，`source.options` 的继承由 `origin.ref` 表达（今天分别写在 `session.ts:119-140`、`rewind.ts:198`、`continue-elsewhere.ts:103`）。
4. `openRoleSession`（`apps/server/src/role-session.ts:37`）改为它的薄封装：建任务 → `startSession({origin:{kind:'derive'}})` → `afterBuilt` 写派生记录 → 写来历。
5. 收掉 `startSavedSession` 的重复逻辑（`sessions.ts:126`），保留导出名一个版本。

### 5.3 验收

- 四条路径（新建 / 续跑 / 分叉 / 换机）各自冒烟：会话 `status=running`、`options` 等于预期快照、`environmentRevision` 与库中一致。
- 新增断言：fork 后 hub 重启，`ensureHosted` 用 `session.options` 恢复（当前 bug：落库写 `{}` 已修，需回归用例防止再退化）。

## 6. 分期与排期

| 阶段 | 内容 | 改动面 | 预估 | 回滚 |
| --- | --- | --- | --- | --- |
| P1 | `AgentRef{runtime,model,options}` + 内嵌 + 校验单点 + `sessionRef()` | domain、storage 读组装、2 条路由导出常量、`sessions.ts` 归一处 | 1 天 | 独立提交，可 revert |
| P3 | `startSession` + `EnvironmentPlanner` 端口 + `buildEnvironment` 抽离 | domain 用例 + `apps/server` 编排 + `session-environment.ts` | 2–3 天 | 旧函数保留薄壳，可回退入口 |
| P2a | 删 `AgentRole`，domain 内统一 `bot` | domain + tests | 0.5 天 | 纯重命名，可 revert |
| P2b | `role:` → `bot:` 一次性迁移脚本 + 双读 | `scripts/`、三处键读写 | 1 天 | 先备份库；脚本可反向重跑 |

顺序：**P1 → P2a（可与 P3 并行）→ P3 → P2b（最后，唯一动历史数据）**。

## 7. 门禁与防回退

- `scripts/check-import-boundaries.mjs`：加一条 `FILE_RULES` —— `agent-profile.ts` / `messaging.ts` / `use-cases/sessions.ts` 不得各自实现选项校验（用「禁止 import 某个内部 helper」不可行，改为在 `check-selftest.mjs` 里加文本断言：这三处出现 `options.length > 200` 之类就失败）。
- `packages/domain/src/agent-ref.test.ts` 作为唯一校验真值表；新增入口必须复用。
- 每阶段结束跑：`check` / `typecheck` / `typecheck:web` / `npm test` / `build` / `test:e2e-node`。

## 8. 风险

| 风险 | 应对 |
| --- | --- |
| `AgentRef` 嵌进 `AgentProfile` 后存储层读组装出错 | 存储层保持三列不动，只在 domain 组装；sqlite 用例覆盖读写往返 |
| 旧客户端仍发 `roles` 字段 | `saveConfig` HTTP 字段保持 `roles`，仅内部改名 |
| `startSession` 把 derive 的行为改坏 | 第 1 步纯重构（buildEnvironment 抽离）先落地并跑全量；第 2 步才挪实现，旧函数留薄壳 |
| `role:` 双读遗漏某处写入 | 加 `grep` 门禁：除 `parseBotKey` 外不得出现字符串 `'role:'` |

## 9. 明确不做

- 不合并 profile 与 bot 两个资源（归属不同：人 vs 项目）。
- 本轮不把 bot 升级成一等聚合（`Bot{id,triggers,credentialRef}`）——按决策 7 留到 C3，避免与启动链改造交叉。
- 不把「对话/会话」的持久性做成 `Session` 字段（临时性属于 workspace 的 `kind`，会话本身全落库）。
- 不为 bot 新增独立 API 面（见 `front-end-layering.md` §10.1）。
