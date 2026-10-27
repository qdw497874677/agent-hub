# 资产中心（Asset Hub）MVP

hub 统一管理「会话能用的能力」，按 **Worker** 安装，经已有的 Worker 长连接下发，hub 启动的会话自动带上。

## 范围

| 做 | 不做（MVP） |
| --- | --- |
| **技能**：Agent Skills 标准目录（根上 `SKILL.md`，frontmatter `name` / `description`） | hooks / bin / 可执行钩子（skill 里出现 `hooks/`、`bin/` 直接拒收） |
| **指令**：一份 markdown，追加到系统提示 | MCP 配置与密钥 |
| 来源：上传（文件 / 文件夹 / zip / 粘贴）、Git（URL + ref + 仓库内路径） | agent 自己写的技能 |
| 版本：不可变、按内容寻址（文件清单的 sha256）、钉住；来源有新版本只标「可升级」，看 diff 确认后才换钉 | 碰机器上已有的技能（`~/.agents`、`~/.claude`、`~/.pi` 等全局目录一律不写） |
| 按 Worker 安装；每台的同步状态 | 按项目 / 按用户安装（以后再说） |

## 分层（六边形）

- **domain**（`asset.ts`、`use-cases/assets.ts`）：名字 / 路径 / 大小规则、打包与 digest（Web Crypto）、版本与钉住、diff 编排、安装关系、同步编排、「Worker 只能取自己清单里的 blob」。
- **端口**：`AssetRepository`（资产 / 版本 / blob / 安装）、`AssetReader`（frontmatter、git、文本 diff）、`AssetDelivery`（推清单）、`AssetSyncBoard`（同步状态）。
- **适配器**：`storage-sqlite/assets.ts`；`adapter-assets`（`yaml` 解析 frontmatter、系统 `git` 浅取、`diff` 生成统一补丁）；`node-gateway` 的 `assets.sync` / `assets.fetch` RPC；`apps/server/assets.ts`（`/api/admin/assets/*`，主人专用）。

## Git 来源的安全措施

`git init` + `fetch --depth 1 origin <ref|HEAD>` + `checkout --detach`，带：`core.hooksPath=/dev/null`、`protocol.file.allow=never`、`protocol.ext.allow=never`、`GIT_TERMINAL_PROMPT=0`、`GIT_LFS_SKIP_SMUDGE=1`、超时 60s；地址只认 `https://` / `ssh://` / `git@`；ref 不能以 `-` 开头；读目录时跳过符号链接；临时目录用完即删。

## 下发

1. Worker 上线（hello）或安装 / 升级 / 删除后，hub 算出这台的清单（装给它的资产各取钉住版本），发 `assets.sync { entries }`。
2. Worker 对比本地 `.blobs/`，缺的按 sha256 批量 `assets.fetch`（每批 ≤ 200 个、≤ 8 MB）；hub 只给这台清单里有的。
3. Worker 校验哈希，分阶段写到临时目录再原子改名；清单外的条目删掉，blob 回收；回报 `{ root, installed }`。
4. hub 记同步状态（pending / syncing / synced / failed）；离线的记 pending，下次上线自动补。

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
| OpenCode（ACP） | `OPENCODE_CONFIG_CONTENT={"skills":[dir],"instructions":[files]}` | 同左 | 线上 |
| Grok（ACP） | `--rules`：技能索引（名字、描述、SKILL.md 绝对路径，「相关时先读」） | 同一段 `--rules` 里附指令全文 | 只验证了参数被接受；远端 Grok 未登录，未做线上会话 |

其他运行时没有注入口时，退回 MCP 工具方案（以后再做）。
