# 资产上架与审核（成员可上架 + 审核流）设计

> 状态：方案（ADR 0016 proposed）。只是设计，不含实现。
> 起点：`docs/design/asset-hub.md`（资产中心 MVP）。今天只有 hub 管理员（持 `hub.assets`）能上架，成员只能「用」。

## 1. 目标与不做

| 做 | 不做（本期） |
| --- | --- |
| 成员能上架技能 / 指令 / MCP 到个人、项目、团队；hubAdmin 可发布到全局 | 跨 hub 的公开市场、付费 |
| 统一审核流：提交 → 审核 → 发布；新版本和 Git 更新都重审 | 自动扫描通过就自动发布 |
| 审核台：diff、校验结果、脚本静态检查、MCP 风险摘要、密钥引用 | 沙箱里试跑 MCP（列为后续） |
| 资产市场 / 目录：浏览、搜索、一键装到自己的项目（适配手机） | 评分、评论区 |
| 通知、审计、迁移 | hooks / bin / 可执行文件（仍按 MVP 拒收） |

## 2. 归属与作用域

每个资产记录：`id, kind, name, ownerId, teamId, scope, projectId?, status, publishedVersionId?`。

| scope | 谁能看见 / 用 | 谁能上架 | 是否需要审核 |
| --- | --- | --- | --- |
| `personal` | 只有作者本人的会话 | 任何成员（`asset.submit`） | 否（见 §6.3 限制） |
| `project` | 该项目的会话（项目成员） | 对该项目有 `project.update` 的人 | 是，1 人 |
| `team` | 团队内所有会话 | 团队成员 | 是，1 人 |
| `global` | hub 上所有团队 | 只能由 team 资产「申请提升」，或 hubAdmin 直接上架 | 是，hubAdmin（可选 2 人） |

- **会话取用顺序**：personal（会话创建者）> project > team > global；同名就近覆盖。沿用 MVP 的项目开关「项目资产优先」，并加「不继承 team / global」开关。
- **跨团队**：遵守 ADR 0011，team / project / personal 资产绝不跨团队可见；只有 global 跨团队。
- **提升（promote）**：personal → team / project、team → global 都是「以同一内容提交一个更高作用域的审核」，不是改字段。

## 3. 权限（接入 `can()`）

新增权限（`packages/domain/src/access.ts`）：

| 权限 | 含义 | owner | member | 备注 |
| --- | --- | --- | --- | --- |
| `asset.read` | 在目录里看到资产及其内容 | team | team | 只看本团队 + global |
| `asset.submit` | 新建资产 / 提交新版本 | team | own | own = 自己是 ownerId |
| `asset.review` | 审核（通过 / 驳回 / 要求修改） | team | — | 指定审核人追加 team |
| `asset.assign` | 把已发布资产装到 Worker | team | own | 还要同时满足该 Worker 的 `worker.manage` |
| `asset.retire` | 下架 / 撤回 | team | own | 作者可撤回自己的；owner 可强制 |
| `asset.secret.use` | 在资产里引用密钥名 | team | own | 见 §10 |
| `asset.publish_global` | 审核 / 发布全局资产 | — | — | hub 级（HUB_PERMISSIONS），只看 hubAdmin |

- `hub.assets` 保留：hub 运营（全局资产、强制下架任何资产、迁移、风险规则配置）。
- **指定审核人**：团队设置 `assetReviewers: userId[]`。实现上不新增角色，`can()` 在 `asset.review` 时额外检查名单（与 `localWorkerGrants` 同一思路），保持「角色 = 权限集」。以后加 `admin` 角色时直接在 `ROLE_PERMISSIONS` 给 `asset.review: team`。
- **API 令牌（ADR 0015）**：`asset.submit` 可进令牌 scope（CI 推送新版本）；`asset.review`、`asset.publish_global`、`asset.secret.use` 进 `NEVER_GRANTABLE`——审核必须是人在界面上点。
- 权限矩阵测试（`access.test.ts`、`apps/server/src/assets.test.ts`）扩展覆盖每个新接口。

## 4. 生命周期（版本状态机）

资产本身只有名字和归属；**状态挂在版本上**：

```
draft ──提交──▶ submitted ──通过──▶ approved ──发布──▶ published ──新版发布──▶ superseded
  ▲                │  │                                   │
  └──要求修改───────┘  └──驳回──▶ rejected                  └──撤回/下架──▶ revoked
```

- `approved → published` 默认自动（审核通过即发布）；2 人审核时第二人通过才算 approved。
- 作者可在 `submitted` 时撤回成 `draft`。
- 同一资产同时最多一个 `submitted` 版本；再提交会替换（旧的标 `withdrawn`）。
- **新版本**：上传或 Git 导入新内容 → 新版本 `submitted`。已发布版本在新版本通过前**保持钉住**，Worker 上不变。
- **Git 更新**：沿用 `checkAllAssetUpdates`：检测到新内容不再只标「可升级」，而是生成一个 `submitted` 版本（提交人记「自动检查」，作者为资产 owner），进入审核队列。因为提交人是系统，作者本人**可以**审核吗？——不行：作者仍视为提交方（防止「自己改 Git 再自己点通过」）。personal 资产除外（作者确认即生效）。
- **撤回 / 下架**：`revoked` 后 hub 从所有清单中移除并推 `assets.sync`；正在跑的会话不受影响，下次开会话不再带。紧急下架（发现恶意）由 owner / hubAdmin 执行，强制写原因。

## 5. 审核台（Reviewer UI）

入口：后台「资产 → 待审核（N）」；手机上是单列卡片。每个待审版本一页：

1. **概要**：名字、种类、作用域、作者、提交时间、来源（上传 / Git URL + ref + commit）、上一已发布版本。
2. **Diff**：对上一已发布版本的统一 diff（MVP 已有 `AssetReader.diff`），首次提交则显示全文；文件列表标新增 / 删除 / 修改；大文件折叠。
3. **校验结果**：`packAsset` 的结果（必过，否则不能提交）。
4. **脚本静态检查**（`AssetScanner` 端口，见 §12）：对 `.sh .py .js .ts .ps1` 等给出标记，如：网络下载后执行（`curl | sh`）、`eval`/`exec`、写 `~`/系统目录、读 `~/.ssh` / 环境变量批量外发、base64 解码后执行、修改 shell 配置、`rm -rf`、混淆（超长单行、高熵字符串）。只标「需注意」等级 info / warn / high，不自动拒绝。
5. **指令 / SKILL.md 提示注入检查**：标记「忽略之前的指令」「不要告诉用户」「把…发送到 URL」、隐藏 Unicode（零宽、双向控制字符）、HTML 注释里的指令、要求读取密钥 / 环境变量等。零宽和双向控制字符直接作为 **high**。
6. **MCP 风险摘要**（kind = mcp）：
   - 传输：stdio（在 Worker 上执行命令，**高风险**）/ http（hub 代连，风险较低）。
   - stdio：`command` + `args` 原样展示；是否 `npx -y` / `uvx` / `pipx run` 拉取远端包（标注包名与是否钉了版本，未钉版本 = warn）；是否 shell 包装（`sh -c`、`bash -lc` = high）；是否绝对路径执行机器上的程序。
   - http：域名、是否 https、是否内网地址（RFC1918 / localhost = high，防 SSRF 打 hub 内网）。
   - 与上一版本比：命令 / 域名变化单独高亮。
7. **密钥引用**：列出所有 `${secret:NAME}`，每个标注归属（个人 / 团队 / hub）、是否已设、提交人是否有权引用；新增引用高亮。
8. **操作**：通过 / 要求修改 / 驳回（后两者原因必填）、逐行评论（锚定文件 + 行号），评论留在版本上，作者改完再提交时显示「上次意见」。

## 6. 审核规则

### 6.1 谁审
| 作用域 | 审核人 |
| --- | --- |
| project / team | 团队 owner 或指定审核人（`asset.review`） |
| global | hubAdmin（`asset.publish_global`） |

### 6.2 硬规则（domain 纯函数 `canReview(version, reviewer)`）
- 审核人 ≠ 提交人，≠ 资产 owner（含 Git 自动提交的情况）。
- 同一版本两名审核人必须不同人。
- 团队只有一人（作者就是唯一 owner）时：project / team 资产无法互审 → 作者可以选「仅个人」或请求 hubAdmin 审（降级规则，见 §16 Q3）。
- hubAdmin 自己提交 global 资产：默认允许「自审 + 审计标记」（单人 hub 的现实），可配置为必须第二人。

### 6.3 personal 不审的限制
- 只对作者本人的会话生效；只能装到作者有 `worker.manage` 的机器（自己注册的 Worker），**团队共享 Worker 和本机 Worker 不行**。
- MCP stdio 的 personal 资产也是如此——在你自己的机器上跑你自己的命令。

### 6.4 2 人审核（可选）
团队设置 / hub 设置：`requireTwoReviewers: { global: boolean, mcpStdio: boolean }`，默认 global = 关（单人 hub）、mcpStdio = 关，团队可开。

## 7. 反馈与追责
- 每个状态变化写审计：`asset.version.submit / approve / reject / request_changes / publish / revoke / assign`，带 actor（用户 id、经由令牌时带令牌 id，ADR 0015）、版本 digest、原因。
- 驳回 / 要求修改原因必填；评论保留，不可删除（可编辑留痕）。
- 已发布版本永远可追溯「谁提交、谁审核、当时扫描结果」：扫描报告随版本存档（`asset_review_reports`）。
- 会话资产清单（`session_assets`）加 `versionId`，从任一会话能点回到该版本的审核记录。

## 8. 分配到 Worker
- 已发布资产进入目录后，**安装**有两种：
  1. **装到项目**（多数情况）：项目里「启用」该资产 → 在该项目的会话上生效，Worker 侧由会话启动时按项目清单下发。需要 `project.update` + `asset.read`。
  2. **装到 Worker**（文件型技能 / 指令常驻）：需要 `asset.assign` + 对该 Worker 的 `worker.manage`（`authorizeWorker`）。成员只能装到自己注册的 Worker；团队共享 Worker 需团队 owner。
- **本机 Worker（hub 所在机器）**：只允许 hubAdmin 安装任何资产，MCP stdio 资产即使 hubAdmin 也要二次确认。
- Worker 清单计算加作用域过滤：一台 Worker 只拿到「装给它且对其团队可见」的资产 blob。
- 资产被 revoke 时，清单自动移除并同步。

## 9. 会话中如何解析
`resolveSessionAssets(session)`：取 global（团队启用的）+ team（启用的）+ project（项目启用的）+ personal（会话创建者的，且装在该 Worker 上），按 §2 顺序去重；只取 `published` 版本。记录到 `session_assets`。

## 10. 密钥
- 密钥库 `SecretVault` 加归属：`scope: personal | team | hub`、`ownerId`、`teamId`；名字唯一性在归属内。引用写法扩展为 `${secret:NAME}`（就近解析：personal → team → hub）或显式 `${secret:team/NAME}`。
- **引用权限**：提交时校验——成员只能引用自己 personal 的和本团队 team 的密钥名；hub 级密钥只有 hubAdmin 能引用。审核时再查一次，发布后**运行时再查一次**（会话创建者对该密钥有 `asset.secret.use` 权限才展开）。
- personal 密钥用于 team 资产？不允许（否则别人的会话用你的密钥）——team / project / global 资产只能引用 team / hub 密钥。
- **永不可读**：没有任何接口返回值；成员设置自己的密钥只写不读；审核台只显示名字、归属、是否已设。
- 审计只记名字（沿用 `asset.secret.set/delete`）。

## 11. 资产市场 / 目录
- 页面「资产」对所有成员开放（不再藏在运营后台）。标签：**目录**（global + 本团队已发布）/ **我的**（草稿、审核中、被驳回、已发布）/ **待审核**（有权限才显示，带数）。
- 卡片：名字、种类图标、作用域徽章、作者、描述、最近版本、风险徽章（如「stdio MCP」「需密钥」）。搜索 + 种类 / 作用域筛选。
- 详情：README（SKILL.md 渲染）、文件树、版本历史、审核记录摘要、「装到我的项目」（选项目，下拉只列有 `project.update` 的）、「装到我的 Worker」。
- 新建：上传 / Git / 粘贴，选作用域，保存草稿 → 提交审核；提交前在本地就跑完校验与扫描，让作者先看到同一份报告。
- **移动端**：单列卡片、底部 tab、审核操作放在吸底按钮条；diff 在手机上默认按文件折叠、行内换行；评论用底部弹层。

## 12. 分层（六边形）
- **domain**
  - `asset.ts` 扩展：`AssetScope`、`AssetVersionStatus` 状态机（`transition(version, action, actor)` 返回新状态或中文错误）。
  - `asset-review.ts`：`canReview`、`requiredApprovals(asset, settings)`、`resolveSessionAssets`、`secretRefAllowed`、MCP 风险规则 `summarizeMcpRisk(mcpJson, previous?)`（纯函数，可单测）。
  - `access.ts`：新权限 + 角色映射 + 审核人名单。
- **端口**：`AssetRepository`（加版本状态、评论、审核记录）、`AssetScanner`（脚本静态检查 + 提示注入检查，返回 findings）、`Notifier`（已有的话复用）、`SecretVault`（加归属）。
- **适配器**：`adapter-assets/scanner.ts`（基于正则 + 简单词法的规则集，规则表可配置，**不执行任何内容**）；`storage-sqlite` 迁移；`apps/server/assets.ts` 拆成 `/api/assets/*`（成员）和 `/api/admin/assets/*`（hub 运营）；Web 端市场 / 审核台页面。
- **开放 API（ADR 0015）**：只读目录与 `asset.submit`（推版本）暴露在 `/openapi/v1`；审核不暴露。

## 13. 通知
- 提交 → 通知所有有资格的审核人（站内 + 可选邮件）；后台导航显示待审数。
- 通过 / 驳回 / 要求修改 → 通知作者（带原因）。
- Git 自动检测到新版本 → 通知作者和审核人。
- 已装的资产发布新版本 → 通知使用它的项目 owner（「已自动升级到 v3」）。
- 资产被紧急下架 → 通知作者和所有安装方。
- 超过 N 天（默认 3）无人审 → 提醒一次。

## 14. 迁移
1. 加表 / 字段：`assets.scope/ownerId/teamId/status`，`asset_versions.status/submittedBy/reviewedBy...`，`asset_reviews`、`asset_comments`、`asset_review_reports`，`secrets.scope/ownerId/teamId`。
2. 现有资产 → `scope = global`（有 `projectId` 的 → `project`，团队 = hub 团队），`ownerId = hubAdmin`；所有历史版本 `published`/`superseded`，当前钉住的为 `published`，审核人记「迁移」。
3. 现有密钥 → `scope = hub`。
4. 现有「可升级」标记 → 转成 `submitted` 版本进入队列。
5. 写一条 `asset.migrate` 审计。Worker 清单不变（迁移前后同步结果应一致，加一条测试锁住）。

## 15. 风险与对策
| 风险 | 对策 |
| --- | --- |
| 恶意技能（脚本外发、破坏） | 必须审核；静态检查标记；不收可执行文件；personal 只能落到作者自己的机器；紧急下架 + 全量同步 |
| 指令里的提示注入 | 注入启发式 + 零宽/双向字符硬标记；diff 必看；作用域越大审核越严 |
| MCP stdio 在 Worker 上执行命令 | 默认高风险徽章；`npx` 未钉版本警告；shell 包装 high；本机 Worker 只有 hubAdmin；可开 2 人审核；命令变化必重审 |
| Git 来源被篡改 / 更换 | 每次更新都是新版本重审；钉 commit；URL 或 ref 变化高亮 |
| 审核走过场 | 扫描 high 时需要勾「我已看过高风险项」才能通过；审计可查 |
| 密钥被滥用 | 引用三次校验（提交 / 审核 / 运行时）；值永不可读；personal 密钥不能进共享资产 |
| 内网 SSRF（http MCP 指向 hub 内网） | 私有地址 high；可配置 hub 拒绝代连私网 |
| 审核瓶颈 | 指定审核人、待审数、超时提醒 |

## 16. 分期
- **P1 数据与权限**：迁移、新权限、版本状态机、`/api/assets` 成员接口（personal + team 提交、审核、发布）、自审禁止、审计。最简审核台（diff + 校验 + 通过/驳回）。
- **P2 审核依据**：`AssetScanner`（脚本 + 注入）、MCP 风险摘要、密钥引用清单、评论；Git 更新进审核队列；通知。
- **P3 市场与分配**：目录页（移动端）、装到项目 / 装到 Worker（权限联动）、project 作用域、密钥归属。
- **P4 全局与加固**：promote 到 global、2 人审核、开放 API 推版本、超时提醒、私网代连限制。

每期都带测试：权限矩阵、状态机、`canReview`、迁移前后清单一致、扫描规则样例。

## 17. 决定 / 待决问题（请 David 拍板）

1. **personal 资产要不要审核？**
   A. 不审，但只能装到作者自己的 Worker（**推荐**）；B. 一律审核；C. 文件型不审、MCP stdio 也要审。
2. **谁能当团队审核人？**
   A. 团队 owner + 团队设置里的指定审核人（**推荐**）；B. 只有 owner；C. 团队任何其他成员都能审（互审）。
3. **单人团队 / 单人 hub 的自审怎么办？**
   A. 禁止自审，团队 owner 的资产交给 hubAdmin 审；hubAdmin 自己的全局资产允许「自审 + 审计标记」（**推荐**）；B. 一律禁止（David 需另一个账号审）；C. owner 一律可自审。
4. **2 人审核默认开在哪？**
   A. 默认都关，团队 / hub 设置里可开 global 与 MCP stdio（**推荐**）；B. MCP stdio 默认开；C. global + MCP 都默认开。
5. **Git 来源有新内容时？**
   A. 自动生成 `submitted` 版本进审核，旧版保持钉住（**推荐**）；B. 只提示，作者手动「提交新版本」；C. 小改动（仅文本）免审。
6. **成员能否把资产装到团队共享 Worker？**
   A. 不能，只能装到项目（会话级下发）或自己的 Worker；共享 Worker 由团队 owner 装（**推荐**）；B. 成员能装，但需审核人批准安装请求；C. 成员能自由装。
