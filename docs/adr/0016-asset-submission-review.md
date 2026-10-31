# ADR 0016：成员上架资产 + 审核流

- 状态：**accepted**（David 2026-10-30 拍板：1A 2A 3A 4A 5A 6B，见 `docs/design/asset-review.md` §17、§18）
- 日期：2026-10-30
- 相关：ADR 0011（团队与 RBAC）、ADR 0015（开放 API / 令牌）、`docs/design/asset-hub.md`

## 背景
资产（技能 / 指令 / MCP）现在只有 hub 级一种作用域，`/api/admin/assets*` 全部要 `hub.assets`，即只有 David 能上架。成员想复用、分享自己的技能只能找 David。资产会进入 agent 的系统提示，MCP 还会在 Worker 上执行命令，放开上架必须配审核。

## 决定
1. **作用域四级**：`personal`（只自己）→ `project` → `team` → `global`（hub 全局）。资产记 `ownerId`、`teamId`、`scope`、`projectId?`。会话取用顺序：personal（会话创建者的）> project > team > global，同名就近优先。
2. **权限进 `can()`**：新增 `asset.read`、`asset.submit`、`asset.review`、`asset.assign`、`asset.secret.use`、`asset.publish_global`（hub 级）。在 `ROLE_PERMISSIONS` 里映射：成员 `asset.submit: own`、`asset.read: team`、`asset.secret.use: own`；owner 全给 `team`；`asset.publish_global` 只有 hubAdmin。另设「指定审核人」名单（团队设置），等于给这几位追加 `asset.review: team`。`hub.assets` 保留为 hub 运营权限（全局资产、迁移、强制下架）。
3. **生命周期 = 版本状态机**：资产本身只是名字和归属；每个**版本**走 `draft → submitted → (changes_requested | rejected | approved) → published → superseded / revoked`。新版本、Git 来源检测到的更新都生成新的 `submitted` 版本，**重新审核**；已发布版本在新版本通过前保持钉住不变。
4. **审核规则**：不能自审（提交人 ≠ 审核人，也不能是同一 API 令牌背后的人）；personal 不需审核（只自己用、只能装到自己能 `worker.manage` 的机器）；project / team 需要 1 名团队 owner 或指定审核人；global 需要 hubAdmin；**MCP（stdio）与 global 可配置为 2 人审核**。驳回必须写原因。
5. **审核依据由 hub 自动生成**：diff（对上一已发布版本）、`packAsset` 校验结果、脚本静态检查、MCP 命令 / 网络风险摘要、密钥引用清单、指令里的提示注入启发式标记。全部是**提示，不替代人审**。
6. **下发**：资产通过后，谁能装到哪台 Worker 由 `asset.assign` + 该 Worker 的 `worker.manage` 共同决定；本机 Worker 仍只允许 hubAdmin 安装。
7. **密钥**：密钥库按归属分为 personal / team / hub；成员只能引用自己的和本团队的密钥名，任何人都读不到值；审核界面只显示引用了哪些名字、归属是谁、是否已设。
8. **迁移**：现有资产全部变成 `scope=global`、`published`，作者记为 David，历史版本保留为已发布，审计写一条迁移记录。
9. **分层**：审核状态机、自审禁止、作用域解析、风险摘要规则全在 domain（纯函数）；静态检查器、diff、通知作为端口 + 适配器。

## 后果
- 正面：成员能沉淀并分享能力；hub 管理员从「唯一上架人」变成「全局资产把关人」；每次进入会话的内容都有人审过并留痕。
- 负面：数据模型与 UI 明显变大；审核会成为瓶颈（需要通知和待审数）；静态检查只能降低风险，不能保证安全。

## 备选（拟否决）
- 只开放「项目内资产」、不做审核：成员的 MCP stdio 会直接在团队 Worker 上执行，风险不可接受。
- 审核只在 hub 级：团队多了以后 David 成为瓶颈，也违背 ADR 0011「团队自治」。
- 自动扫描通过即发布：提示注入和恶意脚本没有可靠的自动判定。

## 拍板与实现说明（2026-10-30）
- 1A personal 不审，只能装到作者自己的 Worker；2A 团队主人 + 指定审核人审团队资产；3A 禁止自批，主人 / 单人团队的提交转 hub 管理员，hub 管理员对全局资产可自批并在审计里打 `asset.self_approve` 标记；4A 全局与 MCP stdio 可开「需 2 人通过」，默认关；5A Git 有更新 → 生成待审提交，旧的锁定版本照常用；6B 装到共享团队 Worker 要发安装申请，由 Worker 主人批准。
- 审核人存在通用授权表 `access_grants`（`permission='asset.review'`，scope `team`），与 ADR 0017 一致；权限名仍是本 ADR 的 `asset.*`。
- **解释（超出 3A 字面）**：当 hub 管理员是某个 project / team 提交唯一有资格的审核人（例如他自己就是团队主人）时，同样允许自批，带同一审计标记。hub 级审核人只能从 hub 管理员所在团队里选。
- 迁移：已有资产全部转为 global（有项目绑定的转 project），owner 记为 hub 管理员；已有密钥归 hub 作用域；Worker 资产清单迁移前后逐字节相同（`asset-review.test.ts` 覆盖）。
