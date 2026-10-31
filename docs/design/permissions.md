# 权限模型设计：按资源类型的权限 + 集群管理员（ADR 0017）

> 状态：**accepted**，已实现（见 ADR 0017「David 的决定」；决定 1A 2A 3A 4A 5A 6B）。关联：ADR 0011（团队 RBAC）、0010（运行时安装）、0013（模型提供商）、0014（资源指标）、0015（开放 API）、0016（资产审核，PR #119）。
>
> David 的要求：「不同模型的权限要设计好，worker 的、项目的、任务的；hub 主机上的 worker 权限只对应一个角色，比如集群管理员。」这里的「模型」理解为**资源类型**。

## 0. 结论先说

1. **三层**：hub 级角色（`cluster_admin` 集群管理员）→ 团队级角色（`owner` / `admin` / `member` / `viewer`）→ 资源关系（创建者、共享、Worker 接入人）。
2. **本机 Worker（hub 主机上的 Worker）的一切权限只属于 `cluster_admin` 这个角色**：用、管、装运行时、改资源策略、看终端。不再有按人授权的 `localWorkerGrants`，团队 owner 也拿不到，令牌永远拿不到。
3. **权限点按资源类型拆细**：`worker.*`、`project.*`、`task.*`、`session.*`、`provider.*`、`asset.*`、`token.*`、`audit.*`、`team.*`、`hub.*`。
4. **一个判断入口** `can(subject, action, resource)`；角色定义是数据（配置表），检查顺序固定：主体有效 → 令牌交集 → hub 级 → 本机 Worker 闸门 → 团队边界 → 角色范围 → 资源关系 / 显式授权。
5. **矩阵由表驱动测试钉住**：每个（角色 × 动作 × 资源情形）一行，改一格必须改测试。

## 1. 现状盘点（`packages/domain/src/access.ts` 及各检查点）

### 1.1 权限点与角色

| 来源 | 内容 |
|---|---|
| `Permission`（24 个） | `project.read/create/update/delete/restore/purge/share`、`session.read/create/control`、`task.read/write`、`worker.read/use/use_local/enroll/manage`、`runtime.install`、`member.invite/manage`、`audit.read`、`hub.settings/users/assets` |
| `ROLE_PERMISSIONS.owner` | `TEAM_ALL`：上面除 `hub.*` 外全部，范围 `team` |
| `ROLE_PERMISSIONS.member` | 项目 / 会话 / 任务 `own`（创建 `team`）；`worker.read/use/use_local/enroll` 为 `team`；`worker.manage`、`runtime.install` 为 `own`；无 `member.*`、`audit.read` |
| `HUB_PERMISSIONS` | `hub.settings/users/assets`：只看 `user.hubAdmin` 布尔 |
| 本机 Worker | `resource.local`：hubAdmin 全放行；其他人 `runtime.install`/`worker.manage` 一律拒；hub 团队里在 `settings.localWorkerGrants` 名单的人可「用」；别的团队永远不行 |
| `membersCanAddMachines` | 关掉后非 owner 拿不到 `worker.enroll` |
| 令牌（ADR 0015） | `API_SCOPES` 5 个 → `SCOPE_PERMISSIONS`；`can()` 里取交集；`NEVER_GRANTABLE` 含 `worker.use_local`、`hub.*`；`resource.local` 一律拒 |
| 指标（ADR 0014） | 机器 / 会话资源占用走 `worker.read` |
| 资源策略 | `use-cases/resources.ts` 改策略走 `worker.manage`（本机 Worker 传 null 凭据 → 只有 hubAdmin） |
| 运行时安装（ADR 0010） | 装了账号体系走 `can('runtime.install')`；否则走 `runtime-install.ts` 的 `canManageRuntimes`（直接比 `role === 'owner'`、`enrolledBy`） |
| 提供商（ADR 0013） | `provider.ts` 的 `canManageProvider` / `canSeeProvider`，**不走 `can()`**：hub 级看 `hubAdmin`，team 级看团队 owner，personal 看 ownerId |
| 软删除 | `project.delete/restore/purge`；`authorization.ts` 对回收站里的项目只认 restore / purge |
| 团队 | `team.ts`：`member.invite/manage`；`audit.read` 看团队审计；删人时项目转给 team owner |
| 资产（ADR 0016，PR #119 设计） | 新增 `asset.read/submit/review/assign/retire/secret.use/publish_global`；`assetReviewers` 名单追加 `asset.review` |

### 1.2 检查点

| 位置 | 做什么 |
|---|---|
| `use-cases/authorization.ts` | 把资源查出来交给 `can()`：`authorizeProject`（先 `project.read` 否则 404，再查动作 403）、`authorizeWorker`（本机先查 `worker.use_local`）、`visibleProjects`、Worker 列表过滤 |
| `apps/server/src/access.ts` / `http.ts` | 路由 id → 资源 → `can()`；新建项目单独查 |
| `apps/server/src/openapi/app.ts` | 先做无资源的粗查（令牌 scope），再走同一套 authorize |
| `use-cases/team.ts`、`admin.ts`、`api-tokens.ts` | 团队、hub 用户、令牌 |
| `use-cases/enrollment.ts` | 接入 / 吊销机器（`worker.manage`） |
| `use-cases/providers.ts` | 自己的 `providerActor`；改机器路由要 hubAdmin |
| `use-cases/delete-project.ts` | 软删除、回收站过滤 |

### 1.3 不一致与缺口

1. **本机 Worker 权限挂在「人」上而不是「角色」上**：`hubAdmin` 布尔 + `localWorkerGrants` 名单。名单是第二条授权通路，审计、UI、测试都要单独处理。
2. **`worker.use_local` 对 member 写成 `team`**，真正是否放行在 `can()` 的特判里；读表的人会误以为成员都能用本机。
3. **绕过 `can()` 的规则**：`canManageRuntimes`（直接比 `role === 'owner'`；无账号体系下 owner 能动本机）、`canManageProvider/canSeeProvider`、`admin.ts` 的 `activeOwners`（跨团队统计所有 `role === 'owner'`）、`team.ts` 删人时的 `createdBy` 比较、`api-tokens.ts` 的「我的令牌」判断。这些都不在权限矩阵测试里。
4. **会话没有自己的资源**：会话、任务都拿所在项目当资源，所以被共享项目的成员能读、能控制**别人**在这个项目里的会话；`session.control` 一个权限点覆盖 prompt / 中断 / fork / 派生 / 换机继续。
5. **`task.write` 太粗**：建、改、删、改状态是同一个点；任务没有自己的创建者规则。
6. **Worker 没有 `delete` / `policy` / `terminal` 的独立权限**：吊销、改资源策略、装运行时之外的管理动作都叫 `worker.manage`。
7. **提供商「读密钥」没有显式禁止**：现在是实现上不返回，不是权限上不允许。
8. **错误码不一致**：提供商路由权限不够时返回 `invalid` 而不是 `forbidden`；文案「只有团队 owner/主人」散落在各处。
9. **hub 管理员唯一且同时是 hub 团队 owner**：`hubAdmin` 是 user 上的布尔，第一个注册的人自动拿；没有「集群管理员」这个角色的概念，也没法有第二个。
10. **`principal === null` 全放行**：单机开发方便，但同一代码路径在生产里如果漏挂账号就是全开；需要显式的 `system` 主体。
11. **资产（ADR 0016）的 `assetReviewers` 名单**与 `localWorkerGrants` 同一模式——本设计把这类名单统一成「显式授权表」。

## 2. 目标模型

### 2.1 三层

| 层 | 角色 / 关系 | 说明 |
|---|---|---|
| hub 级 | `cluster_admin`（集群管理员） | 只有这一个 hub 角色。持有 hub 设置、用户、全局资产、全局提供商，**以及本机 Worker 的全部权限**。可以有多人（建议 1–2 人），David 是第一个。 |
| 团队级 | `owner`、`admin`、`member`、`viewer` | `owner` 唯一、可转让；`admin` = owner 去掉「删团队 / 转让 / 改 owner」；`viewer` 只读。 |
| 资源关系 | `creator`、`shared`（项目成员）、`registrant`（Worker 接入人）、显式授权 | 决定 `own` 范围的人能碰哪几个资源。 |

**关键规则：hub 角色不越过团队边界读数据**（沿用 ADR 0011）。集群管理员管的是 hub 本身和本机 Worker，不自动读别的团队的项目 / 会话；排障需要时走「临时加入团队」并写审计。

### 2.2 本机 Worker（hub 主机）

- 本机 Worker 不属于任何团队，属于 hub：`resource = { kind: 'worker', local: true, teamId: null }`。
- `worker.*`、`runtime.*` 在 `local: true` 上**只问 `cluster_admin`**；团队角色、显式授权、令牌都不参与，`can()` 里第一道闸就挡掉。
- 集群管理员在本机上开的会话，会话本身仍属于他所在团队的项目（数据归属不变）。
- 结果：本机上能执行命令的只有集群管理员；名单 `localWorkerGrants` 删除。

### 2.3 权限矩阵

范围记号：**T** = 本团队全部；**O** = 自己建的 / 共享给自己的 / 自己接入的；**—** = 无；**CA** = 只有集群管理员。所有行都受「令牌交集」与「本机 Worker 只给 CA」约束。

**Worker（远程，属于团队）**

| 动作 | owner | admin | member | viewer | 备注 |
|---|---|---|---|---|---|
| `worker.read`（列表、状态、指标） | T | T | T | T | ADR 0014 指标同此 |
| `worker.use`（在上面开会话） | T | T | T | — | |
| `worker.enroll`（接入新机器） | T | T | T* | — | *受 `membersCanAddMachines` |
| `worker.manage`（改名、标签、重连） | T | T | O | — | O = 接入人 |
| `worker.policy`（资源策略，ADR 0014） | T | T | O | — | 从 `worker.manage` 拆出 |
| `runtime.install` / `runtime.uninstall` | T | T | O | — | |
| `worker.delete`（吊销凭据、移除） | T | T | O | — | |
| `worker.terminal`（直接终端，若开放） | T | — | — | — | 预留 |

**本机 Worker（hub 主机）**：上表每一行都只有 **CA**；团队角色全部 **—**。

**项目**

| 动作 | owner | admin | member | viewer |
|---|---|---|---|---|
| `project.read` | T | T | O | T |
| `project.create` | T | T | T | — |
| `project.update` | T | T | O | — |
| `project.share`（加 / 移项目成员） | T | T | O（仅创建者） | — |
| `project.delete` / `project.restore` | T | T | O（仅创建者） | — |
| `project.purge` | T | — | — | — |

**任务**（继承项目；O 指「在我能 read 的项目里」）

| 动作 | owner | admin | member | viewer |
|---|---|---|---|---|
| `task.read` | T | T | O | T |
| `task.create` | T | T | O | — |
| `task.update`（标题、状态、指派） | T | T | O | — |
| `task.delete` | T | T | 创建者 | — |

**会话**（继承项目，但会话有自己的创建者）

| 动作 | owner | admin | member | viewer |
|---|---|---|---|---|
| `session.read` | T | T | O（项目可读即可读） | T |
| `session.create` | T | T | O | — |
| `session.prompt` | T | T | 会话创建者 + 显式授权 | — |
| `session.interrupt` | T | T | 会话创建者 | — |
| `session.fork` / `session.derive` | T | T | O（项目可写即可） | — |
| `session.continue_elsewhere`（换机继续） | T | T | 会话创建者，且对目标 Worker 有 `worker.use` | — |
| `session.delete` | T | T | 会话创建者 | — |

**模型提供商**（scope = hub / team / personal）

| 动作 | hub 提供商 | team 提供商 | personal 提供商 |
|---|---|---|---|
| `provider.read`（名字、模型列表） | 所有人 | 本团队所有人 | 本人 |
| `provider.use`（会话选用） | 所有登录用户（CA 可按团队关闭） | 本团队 owner/admin/member | 本人 |
| `provider.manage`（增删改、改路由） | CA | owner / admin | 本人 |
| `provider.secret.read` | **永远没有** | **永远没有** | **永远没有** |

**资产（与 ADR 0016 对齐）**

| 动作 | owner | admin | member | viewer | 备注 |
|---|---|---|---|---|---|
| `asset.read` | T | T | T | T | 本团队 + global |
| `asset.submit` | T | T | O | — | |
| `asset.review` | T | T | 显式授权 | — | `assetReviewers` → 授权表里的 `asset.review` 授权；不能自审 |
| `asset.assign` | T | T | O | — | 还要目标 Worker 的 `worker.manage`；本机 Worker → 只有 CA |
| `asset.retire` | T | T | O | — | |
| `asset.secret.use` | T | T | O | — | |
| `asset.publish_global` | CA | | | | hub 级 |

**令牌、审计、团队成员**

| 动作 | owner | admin | member | viewer |
|---|---|---|---|---|
| `token.manage_own`（个人令牌） | ✓ | ✓ | ✓ | ✓（权限自然只读） |
| `token.manage_service`（服务账号） | T | T | — | — |
| `audit.read`（团队审计） | T | T | 自己的操作 | — |
| `team.invite` | T | T | — | — |
| `team.manage`（改角色、停用、移除） | T | admin 不能动 owner 和其他 admin | — | — |
| `team.transfer` / `team.delete` | T | — | — | — |

**hub 级（只有 CA）**：`hub.settings`、`hub.users`、`hub.assets`、`hub.providers`、`hub.audit`（hub 级事件：登录、设置、本机 Worker），以及上面「本机 Worker」一整块。

### 2.4 不可授予（`NEVER_GRANTABLE` 扩展）

令牌、显式授权表、自定义角色**都拿不到**：所有 `hub.*`、所有本机 Worker 权限、`provider.secret.read`、`asset.review`、`asset.publish_global`、`team.transfer`、`team.delete`。

## 3. 怎么组合：一个 `can()`

```ts
type Subject = { user: User; hubRoles: HubRole[]; teamRole: TeamRole | null; via?: TokenGrant } | { system: true };
type Resource = { kind: 'worker' | 'project' | 'task' | 'session' | 'provider' | 'asset' | 'token' | 'team' | 'hub';
                  teamId: string | null; local?: boolean; createdBy?: string | null;
                  sharedWith?: readonly string[]; parent?: Resource };
can(subject, action, resource?, ctx): Decision   // { allow: boolean; reason: DenyReason }
```

判断顺序（任何一步拒绝即停，`reason` 用于错误文案和审计）：

1. **主体有效**：停用 / 删除 → 拒。`system` 主体（单机开发、内部任务）显式构造，取代 `principal === null`。
2. **令牌交集**：`via` 存在时，动作必须在 scope 打包的权限里，且不在 `NEVER_GRANTABLE`；`resource.local` → 拒。
3. **hub 级动作**（`hub.*`、`asset.publish_global`）→ 只看 `hubRoles` 有没有 `cluster_admin`。
4. **本机 Worker 闸门**：`resource.local`（或其 `parent` 链上有本机 Worker，例如「在本机上开会话」）→ 只看 `cluster_admin`，结束。
5. **团队边界**：`resource.teamId !== user.teamId` → 拒（hub 资源 `teamId: null` 只在第 3 步处理）。
6. **角色范围**：`ROLE_DEFS[teamRole][action]` 得到 `T` / `O` / 无。
7. **资源关系**：`O` 时依次看 `createdBy`、`sharedWith`、`registrant`，再看显式授权表；`parent` 继承见下。

### 3.1 角色是配置

```ts
// packages/domain/src/roles.ts（数据，不是代码分支）
export const ROLE_DEFS = {
  hub:  { cluster_admin: { 'hub.*': 'all', 'worker.*@local': 'all', 'runtime.*@local': 'all' } },
  team: { owner: {...}, admin: {...}, member: {...}, viewer: {...} }
} satisfies RoleDefs;
```

- 内置角色只读；**自定义角色**（后续）= 团队 owner 在 UI 里从「可授予权限」里勾选，存表 `team_roles(team_id, name, permissions_json)`，保存时校验不含 `NEVER_GRANTABLE`、不超过 admin。
- 加一个权限点 = 加一行 + 矩阵测试加一行，不改调用方。

### 3.2 显式授权表

```
grants(id, team_id, subject_user_id, action, resource_kind, resource_id, created_by, created_at, expires_at)
```

- 取代各种名单：`project.members`（共享）、`assetReviewers`（ADR 0016）、会话「允许他也 prompt」。
- 授权只能**缩小或补足 own 范围**，不能跨团队、不能授 `NEVER_GRANTABLE`、授权人自己必须有该权限（不能授出自己没有的）。
- 每次授予 / 撤销写审计。

### 3.3 继承

`project → task → session`：子资源带 `parent`；`read` 沿链继承（项目可读 → 任务、会话可读）；**写类动作不自动继承**，会话的 `prompt / interrupt / delete` 看会话自己的 `createdBy` 与显式授权，项目 owner/admin 例外（T 范围）。Worker 不在这条链上，但「在某 Worker 上开会话」要同时过 `session.create`（项目）和 `worker.use`（Worker），本机 Worker 则走第 4 步。

### 3.4 跨团队

- 团队数据永不跨团队可见；集群管理员也不例外（排障走「临时加入」，带过期、写 hub 审计）。
- hub 级资源（本机 Worker、hub 提供商、global 资产）不属于任何团队，按各自规则对所有团队开放「用 / 读」，「管」只给 CA。

### 3.5 令牌

不变（ADR 0015）：有效权限 = 账号权限 ∩ scope 权限；新拆的权限点（`session.prompt` 等）映射进现有 scope：`sessions:write` = `session.create/prompt/interrupt/fork/derive` + `worker.use`。

## 4. 迁移

1. **数据**：`users.hub_admin = 1` 的人 → `hub_roles(user_id, role='cluster_admin')`；David 成为集群管理员。保留 `hub_admin` 列一个版本做兼容读，之后删除。
2. **`localWorkerGrants`**：推荐**直接删除**（默认，见问题 1）。迁移时把名单里的人写进迁移审计（「本机授权已收回」），设置页提示一次。可选方案：把名单里的人升为 `cluster_admin`。
3. **角色**：现有 `owner` / `member` 原样保留；`admin` / `viewer` 新增，不自动给任何人。
4. **拆权限点**：`session.control` → `prompt/interrupt/fork/derive/continue_elsewhere`；`task.write` → `create/update/delete`；`worker.manage` → `manage/policy/delete`；`member.*` → `team.*`。代码里一次替换，旧名不再存在（不做别名，免得两套）。
5. **收口绕过 `can()` 的地方**：`canManageRuntimes`、`canManageProvider/canSeeProvider`、`activeOwners`、删人转移、`api-tokens` 的归属判断都改成调 `can()`；错误统一 `forbidden` / `notFound`。
6. **`principal === null`**：改为显式 `system` 主体；生产启动时若账号体系没挂上直接拒绝启动。
7. **ADR 0016 资产**：`assetReviewers` 落到 `grants`（`action = 'asset.review', resource_kind = 'team'`）；`asset.*` 加进 `ROLE_DEFS`（admin 同 owner、viewer 只 `asset.read`）；`asset.assign` 到本机 Worker 由第 4 步自动挡住，资产代码无需特判。
8. **测试（锁矩阵）**：
   - `access.matrix.test.ts`：一张表 `[subject, action, resourceCase, expected]`，覆盖 5 角色（CA、owner、admin、member、viewer）× 全部动作 × 资源情形（本团队自己的 / 本团队别人的 / 共享给我的 / 别的团队 / 本机 Worker / hub 资源）× 是否经令牌。`expected` 由一份 markdown 矩阵生成的快照比对，和本文 §2.3 同源。
   - 不变量测试：**枚举所有角色（含自定义角色可选的全部权限）、所有授权组合、所有令牌 scope，断言除 `cluster_admin` 外没有任何主体能在 `local: true` 上得到任何 `worker.*` / `runtime.*`**。
   - e2e：CA 在本机装运行时成功；hub 团队 owner（非 CA）本机全部 403；令牌 403；成员看不到本机。

## 5. UI

- **设置 → 团队 → 成员**：每行一个角色下拉（owner/admin/member/viewer），手机上是卡片 + 底部弹出选择；改 owner 走「转让」单独确认。
- **设置 → 团队 → 角色与权限**：矩阵视图——行是资源类型（可折叠：Worker / 项目 / 任务 / 会话 / 提供商 / 资产 / 令牌 / 审计 / 团队），列是角色，格子是 `全部 / 自己的 / —`；内置角色只读，自定义角色可编辑。手机上改为「先选角色 → 按资源类型分组的开关列表」。
- **hub 设置 → 集群管理员**（仅 CA 可见）：列表 + 添加 / 移除（不能移除最后一个）；本机 Worker 卡片上标「仅集群管理员」。
- **资源详情页**「谁能访问」：项目 / 会话 / Worker 页一个小面板，列出因角色、因共享、因授权能访问的人，可撤销显式授权。
- **拒绝提示**：用 `can()` 返回的 `reason` 显示具体原因（「本机 Worker 只对集群管理员开放」），而不是通用「没有权限」。
- 风格沿用现有设置页：简洁、单列、触控友好（≥44px），不引新组件库。

## 6. 已决问题（2026-10-30 David：1A 2A 3A 4A 5A 6B）

> 下面保留原选项供追溯；第 6 题选了 B（本期一起做自定义角色）。

### 6.1 已知限制

- 会话没有删除接口；4A 里的「删除」由 `task.delete` / `project.delete` 覆盖。
- 个人 API 令牌「只能管自己的」仍是内联关系判断，没走 `can()`。
- 集群管理员的 `hub.users` 能管任何团队的账号（停用、改密），这是账号管理，不是读团队数据。
- 运营后台改角色不接受自定义角色（自定义角色属于团队，只能在团队设置里分配）。
- 审核人行（#119）在授权列表里只读显示，增删走审核设置。

### 6.0 原待决问题

1. **`localWorkerGrants` 现有名单怎么处理？** A. 直接收回（**推荐**，符合「只在一个角色上」）；B. 名单里的人升为集群管理员；C. 保留只读一个版本后收回。
2. **集群管理员可以有几个？** A. 至少 1、可多个（**推荐**，避免单点；建议 ≤2）；B. 只能 1 个。
3. **要不要新增 `admin` / `viewer`？** A. 两个都加（**推荐**，矩阵已覆盖、成本低）；B. 只加 `viewer`；C. 先不加。
4. **会话的 prompt 权限**：A. 只有会话创建者 + owner/admin + 显式授权（**推荐**，修正现有「共享项目就能操控别人会话」）；B. 维持现状（项目可写即可 prompt）。
5. **集群管理员能否读其他团队数据？** A. 不能，排障走带过期的临时加入 + hub 审计（**推荐**，沿用 ADR 0011）；B. 可只读。
6. **自定义角色什么时候做？** A. 本期只做内置 5 角色 + 显式授权表，自定义角色留后续（**推荐**）；B. 本期一起做。
