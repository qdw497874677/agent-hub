# 资产中心（Asset Hub）MVP

hub 统一管理「会话能用的能力」，按 **Worker** 安装，经已有的 Worker 长连接下发，hub 启动的会话自动带上。

## 范围

| 做 | 不做（MVP） |
| --- | --- |
| **技能**：Agent Skills 标准目录（根上 `SKILL.md`，frontmatter `name` / `description`） | hooks / bin / 可执行程序（见下文「校验」） |
| **指令**：一份 markdown，追加到系统提示 | 明文密钥（MCP 配置里只认 `${secret:NAME}`） |
| **MCP 服务器**：一份 `mcp.json`（stdio 或远端 http），密钥另存 | agent 自己写的技能 |
| 来源：上传（文件 / 文件夹 / zip / 粘贴）、Git（URL + ref + 仓库内路径） | |
| 版本：不可变、按内容寻址（文件清单的 sha256）、钉住；来源有新版本只标「可升级」（hub 定时检查），看 diff 确认后才换钉 | 碰机器上已有的技能（`~/.agents`、`~/.claude`、`~/.pi` 等全局目录一律不写） |
| 按 Worker 安装；每台的同步状态；全局或只属于某个项目 | 按用户安装（以后再说） |

## 分层（六边形）

- **domain**（`asset.ts`、`use-cases/assets.ts`）：名字 / 路径 / 大小规则、打包与 digest（Web Crypto）、版本与钉住、diff 编排、安装关系、同步编排、「Worker 只能取自己清单里的 blob」。
- **端口**：`AssetRepository`（资产 / 版本 / blob / 安装）、`AssetReader`（frontmatter、git、文本 diff）、`AssetDelivery`（推清单）、`AssetSyncBoard`（同步状态）。
- **适配器**：`storage-sqlite/assets.ts`；`adapter-assets`（`yaml` 解析 frontmatter、系统 `git` 浅取、`diff` 生成统一补丁）；`node-gateway` 的 `assets.sync` / `assets.fetch` RPC；`apps/server/assets.ts`（`/api/admin/assets/*`，主人专用）。

## 作用域

资产可以是**全局**的，也可以**只属于某个项目**（`projectId`）。开会话时取「全局 + 本项目」的资产；同名时项目的优先（项目设置里可开关）。别的项目的资产不会出现在会话里。

## 权限

| 角色 | 能做 |
| --- | --- |
| 主人 | 增、删、改（上传新版本、检查更新、换钉）、分配到机器、管密钥——`/api/admin/assets*` 全部只认主人（未登录 401，成员 403） |
| 成员 | 只能「用」：自己的会话自动带上分配好的资产；能读会话资产清单 `GET /api/sessions/:id/assets`；界面上看不到运营后台和项目资产设置 |

每个接口的权限都锁在 `apps/server/src/assets.test.ts`「资产权限」一条测试里。

## 校验

上传和 Git 导入都走 `packAsset`，同一套规则，报错都是中文、带文件路径：

- 技能根上必须有 `SKILL.md`，开头是 `---` 包起来的 YAML frontmatter；`name` 必须是一行文字（并符合名字规则：小写字母数字和 `-`，≤ 64），`description` 必须是文字、≤ 1024 字；`SKILL.md` / 指令文件必须是 UTF-8。
- 大小：≤ 200 个文件，单个 ≤ 1 MB，总共 ≤ 4 MB。
- 路径：不能是绝对路径、`..`、反斜杠；根上不能有 `hooks/`、`bin/`、`.git/`；任何一层都不能有 `hooks/`、`.claude-plugin/`。
- 不收可执行程序：扩展名（`.exe .dll .so .dylib .msi .bat .cmd .com .scr .app .apk .jar .deb .rpm`）或文件头魔数（ELF、PE `MZ`、Mach-O / 通用二进制）。`.py`、`.sh` 这类脚本照收。

## 更新提醒

hub 定时（`checkAllAssetUpdates`）逐个查 Git 来源：启动后约 2 分钟一次，之后默认每 6 小时（`HUB_ASSET_CHECK_MS`，0 = 关）。有新内容只记成「最新版本」并写一条审计（操作人「自动检查」），**不自动升级**；资产页顶部提示「有新版本：…」，后台导航「资产」旁显示待升级数，点进去看差异、确认后才换钉并同步到已装的机器。查不了的（网络、来源被改坏）只写日志。

## 会话资产清单

会话启动时 hub 记下这次实际给出的资产（`session_assets` 表）：资产 id、种类、名字、钉住的 digest、作用域（全局 / 项目）。MCP 只记真正接上的。会话检查器里「本会话的资产」一栏展示，成员也能看。

## Git 来源的安全措施

`git init` + `fetch --depth 1 origin <ref|HEAD>` + `checkout --detach`，带：`core.hooksPath=/dev/null`、`protocol.file.allow=never`、`protocol.ext.allow=never`、`GIT_TERMINAL_PROMPT=0`、`GIT_LFS_SKIP_SMUDGE=1`、超时 60s；地址只认 `https://` / `ssh://` / `git@`；ref 不能以 `-` 开头；读目录时跳过符号链接；临时目录用完即删。

## 下发

1. Worker 上线（hello）或安装 / 升级 / 删除后，hub 算出这台的清单（装给它的资产各取钉住版本），发 `assets.sync { entries }`。
2. Worker 对比本地 `.blobs/`，缺的按 sha256 批量 `assets.fetch`（每批 ≤ 200 个、≤ 8 MB）；hub 只给这台清单里有的。
3. Worker 校验哈希，分阶段写到临时目录再原子改名；清单外的条目删掉，blob 回收；回报 `{ root, installed }`。
4. hub 记同步状态（pending / syncing / synced / failed），落库（`asset_sync` 表），hub 重启后照样显示；离线的记 pending，下次上线自动补。

## Worker 上的目录

只用专属目录 `~/.agent-hub/assets`（`WORKER_ASSETS_DIR` 可改）：

```
~/.agent-hub/assets/
  .blobs/<sha256>
  skills/<name>/SKILL.md …
  instructions/<name>.md
  .manifest.json
```

卸载 = 删掉这个目录。hub 启动的会话通过启动参数指向它，不改任何全局配置。

## 运行时注入

| 运行时 | 技能 | 指令 | 验证 |
| --- | --- | --- | --- |
| Pi | `--skill <skills 目录>` | `--append-system-prompt <文件>`（每条一次） | spike + 线上 |
| OpenCode（ACP） | `OPENCODE_CONFIG_CONTENT`：`skills.paths` 加目录；机器上已有这个变量时深合并（用户的值保留，数组追加去重） | `instructions` 加文件，同左 | 线上 |
| Grok（ACP） | session/new 的 `_meta.rules`：技能索引（名字、描述、SKILL.md 绝对路径，「相关时先读」）。`grok agent stdio` 不认命令行 `--rules` | 同一段 rules 里附指令全文 | 本机线上会话已验证（技能 + 指令都生效）；远端 Grok 未登录 |

Pi 的 MCP 依赖 Pi 扩展 `pi-mcp-adapter`：Worker 用 `pi list` 探测，没装时报 `lacks: ['mcp-adapter']`；只有给这台机器装了 MCP 资产时，Pi 才标「缺少 MCP 适配器」不可用，否则照常可用。

其他运行时没有注入口时，退回 MCP 工具方案（以后再做）。

## MCP 服务器与密钥

**资产形态**：kind `mcp`，内容就是一份 `mcp.json`（Git 里可以叫 `xxx.mcp.json`）：

```json
{ "name": "github", "description": "…", "transport": "stdio", "command": "npx", "args": ["-y", "…"], "env": { "TOKEN": "${secret:GITHUB_TOKEN}" } }
{ "name": "docs", "transport": "http", "url": "https://…/mcp", "headers": { "Authorization": "Bearer ${secret:DOCS_TOKEN}" } }
```

- 校验：`env` / `headers` 里像密钥的键（TOKEN、KEY、SECRET、PASSWORD、Authorization…）必须写 `${secret:NAME}`，写明文直接拒收（中文报错）；密钥名只能大写字母、数字、下划线。
- MCP 资产**不当文件同步**到 Worker，只在开会话时按需下发。

**密钥库**（端口 `SecretVault`，适配器 `storage-sqlite/secrets.ts`）：AES-256-GCM 加密落库，AAD = 密钥名；主密钥取 `HUB_SECRET_KEY`，没有就在数据目录生成 `secret.key`（0600）。管理页「密钥」一栏只显示名字、是否已设、被哪些资产引用，**从不回显值**；审计只记名字（`asset.secret.set` / `asset.secret.delete`）。

**会话启动**（`sessionMcpLaunch`，只在会话带 hub 工具时）：

| 传输 | 做法 | 密钥在哪 |
| --- | --- | --- |
| stdio | hub 展开 `${secret:…}`，随 `start_session` 下发；运行时拉起子进程 | 只在那个子进程的 env 里，不落盘、不打日志 |
| http | 只下发名字；Worker 指向本机中转 `/mcp/<名字>`，经 Worker 长连接由 **hub 代连远端** | 只在 hub 内存里（客户端按地址+头的哈希复用）；Worker、agent 都拿不到 |

缺密钥或配置坏的条目跳过（日志只记资产名和原因），会话照常开。

**运行时适配**：

| 运行时 | 做法 |
| --- | --- |
| OpenCode / Grok（ACP） | 标准 `session/new.mcpServers`：stdio 原样，http 指向本机中转并带会话令牌；agent 不会 HTTP MCP 时套 stdio 垫片 |
| Pi | 垫片 `mcp-shim.ts`：`AGENT_HUB_MCP`（JSON）告诉它要聚合哪些，读完即从 env 删掉；工具名 `资产名__工具名` |

没走「改 OpenCode 配置 / Grok `_meta`」：两家 ACP 都认标准 `mcpServers`，一条路径更少出错，也不碰用户配置。

Pi 的项目级资产不落进项目目录：和全局资产一样由垫片聚合进用户全局配置里的 `agent-hub` 一条（Pi 0.99+ 写 `~/.pi/agent/mcp.json`，更老的 Pi 靠 pi-mcp-adapter 7.x，写 `mcp-adapter.json`；都认 `PI_CODING_AGENT_DIR`），不经项目审批，也不改用户的 `projectServers` 等信任设置。之前远端出现的「project server approval required」是因为 hub 只写了 mcp.json、适配器 7.x 在老 Pi 上不读它，模型看到提示后自己写了项目 `.mcp.json`。

本机线上验证（2026-10-28）：Grok、OpenCode、Pi 三家会话都调到了 stdio（`stdio-ok token_len=16`）和远端（`pong-remote-auth-ok`）测试服务器；hub 日志、远端服务器日志、事件流、数据库里都搜不到密钥原文。
