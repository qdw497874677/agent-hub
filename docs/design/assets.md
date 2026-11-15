# 资产：完整修复与演进计划

状态：设计（2026-11-15）。覆盖 #222–#226 的全部资产问题，取代零散补丁的修法。
相关：`docs/design/asset-hub.md`（原始设计）、`docs/design/asset-marketplace.md`（市场/审核）、`docs/design/asset-versions.md`（不可变版本目录）。

## 1. 范围

「资产」= hub 统一管理、下发给会话的能力。当前三类：

| kind | 形态 | 落盘 | 消费方式 |
| --- | --- | --- | --- |
| `skill` | 目录，根上 `SKILL.md`（Agent Skills 标准） | `skills/<name>` / `project-skills/<id8>/<name>` | 运行时把目录路径写进系统提示，agent 自己读 |
| `instruction` | 单份 markdown | `instructions/<slot>.md` | 追加到系统提示 |
| `mcp` | 单份 `mcp.json` | 不落盘 | 会话启动时展开成 MCP 服务器配置（密钥只存引用） |

链路：导入（上传 / git）→ 审核与发布 → 项目资产开关与作用域解析 → `session-environment.prepare()` 组装 → Worker `worker-assets.sync()` 落盘 → 适配器消费 → 会话清单记账。

## 2. 问题清单（按链路分段）

**A. 来源信任**
1. git 导入可指向任意主机 ⇒ SSRF / 内网探测（已由 `asset-git-host.ts` 的 `allowedHosts` 兜住，默认空 = 全拒）。
2. 检出环境会继承调用者的凭据（`SSH_AUTH_SOCK`、`GIT_ASKPASS`、代理）⇒ 凭据外泄 / 借用开发者身份（已修：白名单 env + `BatchMode` + `followRedirects=false`）。
3. 检出目录里的符号链接可越界读取（`lstat` 也返回目录）⇒ 任意文件泄漏（已修：每层 `realpath` + 前缀判断 + 跳过并记日志）。

**B. 打包与版本**
4. 版本号算法与 `withMcp` 交互不一致：`environmentRevision` 算出来的版本与实际下发不一致（#223）。
5. `session_assets` 记的是「hub 以为装了什么」，`current()` 不校验 digest ⇒ 记录与实际可以不一致（#225 M2）。
6. 会话中途换钉 = 原地改名覆盖 ⇒ 正在跑的会话读到新内容或已删除文件（`docs/design/asset-versions.md`）。

**C. 下发与失败语义**
7. `current()` 历史上「没给清单 = 全给」⇒ hub 解析失败被放大成「把机器上所有资产塞进会话」（#223 fail-open）。
8. 资产没准备好时，会话启动照常进行、只是缺东西 ⇒ 用户看到「agent 不听话」而不是明确报错。
9. Worker 上的 `prune()` 会删清单外内容，但 hub 侧 `board.installed` 不校验，导致「已装」与磁盘不一致。

**D. 消费**
10. Grok / Codex / Hermes 把 `SKILL.md` 绝对路径写进系统提示 ⇒ 版本切换后路径失效，静默丢资产（#225 M3）。
11. `instructions` 的拼接顺序与冲突（多条同名/同 slot）没有显式规则。
12. MCP 资产在会话里的可用性（工具是否出现）没有回执，用户只能靠猜。

**E. 密钥与权限**
13. MCP 密钥只存引用（`mcp.ts`），但展开发生在 hub；错误日志 / 会话清单存在泄漏风险。
14. 谁能导入、发布、改项目开关、在会话里看到哪些资产：目前分散在 `assetVisibleIn` + 路由，缺一张权限表。
15. 审核与发布的边界：`pinned` 为空 = 不下发；但「谁能把 revision 发布」与「谁能上架到全局」没有审计闭环。

**F. 观测**
16. 没有「这台机器现在装了什么、哪个会话用了哪个 digest、为什么没给」的运维视图。
17. 失败原因只在日志里，会话界面只有「资产：N 个」。

## 3. 目标模型（不变量）

- **I1 内容寻址**：一个 revision 的 digest = 路径 + 内容哈希的再哈希；同样的文件永远同一个 digest。
- **I2 发布即钉死**：会话拿到的永远是某个已发布 revision，运行期不随来源更新而变。
- **I3 显式清单**：会话启动必须带 `assetIds`（可空 = 明确不要），永不隐式「全给」。
- **I4 失败可见**：任何一类资产没准备好，都必须让用户看到「缺什么、为什么」，不能静默降级。
- **I5 密钥不出 hub**：明文只存在于 hub 进程内与 Worker 启动配置的必要字段；落库、日志、清单、错误里只有哈希或引用。
- **I6 一个入口**：作用域解析只有一个函数（`resolveProjectAssets`），权限判断只有一个地方。

## 4. 决策

- **D1 三类资产共用一套生命周期**（导入 → revision → 发布 → 解析 → 下发 → 消费），差异只在「落盘形态」与「消费方式」。
- **D2 不可变版本目录**（`asset-versions.md`）：`<root>/assets/<digest12>/…`，兼容符号链接指向当前；协议加 `assetRoots`。
- **D3 会话清单落库 = 事实**：`SessionAssetManifest.entries` 记 `assetId/kind/name/digest/scope`，界面与排障都以它为准；`board.installed` 只是缓存。
- **D4 消费契约按「路径」而不是「读文件」**：适配层拿到的永远是版本化路径；不要求运行时支持读文件注入（Grok/Codex/Hermes 保持「路径进提示」），但路径必须指向不可变目录。
- **D5 MCP 走「工具回执」**：会话启动后由 Worker 上报实际挂上的 MCP 服务器名，hub 记 `SessionAssetManifest.mcp`；缺失即为可见失败。
- **D6 失败分级**：`blocked`（会话不启动，如显式要求的资产缺失）、`degraded`（会话启动但清单标注缺失并提示）、`skipped`（项目开关关闭，正常）。默认 `blocked` 只用于「显式钉住且失败」，其余 `degraded`。
- **D7 权限表**：导入/改 = 资产所属作用域的 `project.update`/`team.manage`/管理员；发布 = 同左 + 审核通过；项目开关 = `project.update`；会话可见 = 作用域 + 项目开关。
- **D8 清理按引用计数**：只删「没有任何 `session_assets` 引用且不在最近 N 次 sync」的版本；`prune()` 不再删未知目录以外的历史版本。
- **D9 迁移兼容**：旧 Worker 不认 `assetRoots` 时退回旧路径并记一次警告；协议升版本必须「忽略未知字段」。
- **D10 不做**：资产二进制缓存分发网络、跨团队资产订阅、运行时热更新已启动会话的资产（换版本 = 新会话）。

## 5. 生命周期

```
导入(upload|git)
  → packAsset(校验: 路径/大小/可执行/结构)  → AssetRevision(digest)
  → 审核(市场) → pinned = digest
  → 作用域解析 resolveProjectAssets(visible, 项目开关, 就近优先)
  → session-environment.prepare: assetIds + tools + environmentRevision
  → Worker sync: blobs → 不可变目录 → 兼容链接 → 清单
  → 适配器消费: skills 路径 / instructions 拼接 / MCP 配置
  → SessionAssetManifest 落库 + 工具回执
  → 升级: 新 revision → 新会话生效; 旧版本按引用计数清理
```

## 6. 各运行时消费契约

| 运行时 | skills | instructions | mcp |
| --- | --- | --- | --- |
| OpenCode (ACP) | 目录路径进配置 | 系统提示追加 | `mcpServers` |
| Pi | 同 OpenCode | 同 | 同 |
| Grok | **版本化** `SKILL.md` 绝对路径进系统提示 | 系统提示追加 | 支持则挂，不支持则 `skipped` |
| Codex | 版本化路径 + 明确「缺文件即报错」 | 系统提示追加 | `app-server` 配置 |
| Hermes | 版本化路径 | 系统提示追加 | 视能力 |

统一 requirement：适配器启动时必须校验「清单里声明要给的资产路径存在」，缺一个就上报 `degraded`，不得静默继续。

## 7. 密钥

- `mcp.json` 里密钥只允许 `{"secret": "<name>"}` 引用；真值在 hub 的团队/项目密钥表。
- 展开只发生在 `prepare()`，结果只进 Worker 启动配置；不写 `session_assets`、不写日志、不写错误消息。
- `environmentRevision` 的 MCP 部分只记 env 的 digest（已有 `SessionEnvironmentRevisionInputs.mcp`）。
- 审计：`asset.mcp.expand` 记 `{sessionId, mcpName, secretNames}`，不记值。

## 8. 观测

- Worker 页：每台机器「已装资产 / digest / 最近同步时间 / 错误」。
- 会话页：资产清单（名字、版本、来源、状态：ok/degraded/skipped）。
- 运维：`/api/assets/health` 返回「最近 24h 同步失败、degraded 会话、孤儿版本数」。

## 9. 分期

**阶段 A：修漏洞与失败语义（#222 / #223 / #224，当前在途 lane）**
- git 导入 realpath / 干净环境 / 主机白名单（#222）。
- `current()` fail-closed + `environmentRevision` 与实际下发一致（#223）。
- MCP 密钥展开与日志脱敏（#224，若 lane 已覆盖则验收）。

**阶段 B：版本不可变（#225 M1–M3）**
- M1：revision 输入快照与重算一致（不含明文密钥）。
- M2：不可变目录 + `assetRoots` + 引用计数清理；`current()` 返回 `{path, digest}` 并校验。
- M3：三个适配器改用版本化路径；缺资产上报 `degraded`。

**阶段 C：市场与治理（#226）**
- 审核流、发布审计、团队级资产共享、资产健康视图；`AssetSet`（按 Bot/会话绑定）留到 C 尾。

## 10. 验收

- 单元：`packAsset` 的路径/大小/二进制/结构拒绝；`resolveProjectAssets` 的就近优先与开关；`revisionDigest` 与 `environmentRevision` 重算一致。
- 集成：导入 → 发布 → 会话启动 → Worker 落盘 → 清单落库，断言 digest 三处一致（revision、磁盘、manifest）。
- 安全：符号链接越界、内网主机、带凭据 env、可执行文件四类样本全部拒绝且有明确错误。
- 失败语义：显式钉住但机器未同步 ⇒ 会话不启动且提示；未显式要求 ⇒ 启动 + `degraded` 标注。
- 真机：Grok/Codex/OpenCode 各跑一次「读技能」的会话，换钉后新会话读到新版本、旧会话不受影响。

## 11. 不做

- 已启动会话的资产热更新（换版本 = 新会话）。
- 资产内可执行钩子 / 插件清单（`hooks/`、`.claude-plugin/`、`bin/` 永远拒绝）。
- 资产内容的运行时下载（如 skill 运行时再去拉数据）。

### E4c 落地：协议级冻结

- `start_session` 增加 `assetDigests`（assetId → digest）；hub 从会话快照生成，Worker 按 digest
  取不可变版本目录（`worker-assets.current(only, digests)`），换钉后旧版本仍可读。
- `digestsForWorker` 同时扫 `session_assets` 与 `session_asset_snapshots`，保证 retain 不会把
  在跑会话冻结的旧版本清掉。
- 升级（`POST /api/sessions/:id/assets/upgrade`）只写新快照：**下一次重新托管/启动生效**；
  运行中的进程不会热换文件（D10 不做热更新）。界面提示应写「下次启动生效」。
