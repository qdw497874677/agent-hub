# ADR 0017：按资源类型的权限模型 + 集群管理员独占本机 Worker

- 状态：proposed
- 日期：2026-10-30
- 关联：ADR 0010、0011、0013、0014、0015、0016；设计稿 `docs/design/permissions.md`

## 背景

ADR 0011 建立了「角色 = 权限集、一律走 `can()`」，但随着运行时安装、模型提供商、资源指标、开放 API、资产审核陆续加入，出现了：本机 Worker 权限挂在 `hubAdmin` 布尔和 `localWorkerGrants` 名单两条通路上；多处规则绕过 `can()`（`canManageRuntimes`、`canManageProvider`、`activeOwners` 等）；会话 / 任务没有独立资源，共享项目的成员能操控别人的会话；`session.control`、`task.write`、`worker.manage` 过粗。David 要求按资源类型把权限设计好，且「hub 主机上的 Worker 权限只对应一个角色，比如集群管理员」。

## 决定

1. 三层：hub 角色 `cluster_admin` → 团队角色 `owner / admin / member / viewer` → 资源关系（创建者、共享、接入人、显式授权）。
2. **本机 Worker 的全部 `worker.*` / `runtime.*` 只授予 `cluster_admin`**，在 `can()` 中作为独立闸门、先于团队角色判断；删除 `localWorkerGrants`；令牌、显式授权、自定义角色都不能获得。
3. 权限点按资源类型拆细（worker、project、task、session、provider、asset、token、audit、team、hub），矩阵见设计稿 §2.3。
4. 唯一入口 `can(subject, action, resource)`，固定顺序：主体有效 → 令牌交集 → hub 级 → 本机 Worker → 团队边界 → 角色范围 → 资源关系 / 授权；返回带原因的决定。
5. 角色定义为数据（`ROLE_DEFS`）；名单类授权（项目成员、资产审核人）统一进 `grants` 表；`project → task → session` 只继承 read。
6. `NEVER_GRANTABLE` 扩展为：所有 `hub.*`、本机 Worker 权限、`provider.secret.read`、`asset.review`、`asset.publish_global`、`team.transfer/delete`。
7. 表驱动矩阵测试 + 「除 cluster_admin 外无人能在本机 Worker 上得到任何权限」的枚举不变量测试。
8. ADR 0016 的资产权限并入本模型：`asset.*` 进 `ROLE_DEFS`，`assetReviewers` 落到 `grants`。

## 后果

- 正面：本机执行权只有一条通路、可审计；所有规则可在一张矩阵里看到并被测试锁住；新增资源类型有固定套路。
- 负面：权限点改名、拆分涉及较多调用方；`localWorkerGrants` 名单里的人会失去本机使用权（需提示）。
- 中性：数据模型新增 `hub_roles`、`grants`，后续可选 `team_roles`。

## 备选

- 保留 `localWorkerGrants`：违背「只在一个角色上」，且是第二条授权通路。
- 让团队 owner 也能用本机：本机 = hub 主机，权限过大，拒绝。
- 引入通用 ABAC / 策略引擎（如 Casbin、OPA）：当前规模下一张角色表 + 少量关系即可，引擎带来的复杂度不值得；如果自定义角色和授权规模变大再评估。
