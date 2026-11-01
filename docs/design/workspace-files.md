# 工作空间文件浏览 设计

> 状态：**已定稿（accepted，2026-11-01）**，只是设计，不含代码。对应 ADR 0025。参考 opencode 网页端（commit `69269e4`，2026-11-01）。

## 1. 目标

在会话详情 / 工作空间页里，像 opencode 网页端那样浏览 agent 正在用的工作空间：目录树、模糊找文件、看文件（语法高亮）、看 git 改动和 diff。手机上也要好用。第一阶段**只读**。

## 2. opencode 是怎么做的（读源码）

| 方面 | 做法 | 代码 |
|---|---|---|
| 接口 | `fs.list`（列一层）、`fs.read`（读原始字节流）、`fs.find`（模糊找）、`fs.write`、`fs.watch/unwatch` | [server/handlers/fs.ts](https://github.com/sst/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/server/src/handlers/fs.ts) |
| 懒加载 | 树只在展开目录时调 `fs.list` 取这一层；目录在前、按名排序 | [core/filesystem.ts](https://github.com/sst/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/core/src/filesystem.ts) L166-197，[app/workspaces/files/tree-store.ts](https://github.com/sst/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/app/src/workspaces/files/tree-store.ts) |
| 读文件 | 流式返回，带 ETag（size+mtime）、`Cache-Control: no-cache`、304、HTTP Range（206/416），MIME 按扩展名 | fs.ts `serveFile` |
| 路径安全 | 拒 NUL；`path.resolve` 后检查在 location 内；再 realpath 检查仍在根内（防软链接逃逸）；失败一律报 NotFound 不泄露 | filesystem.ts L133-146 |
| 注意 | `list` **不做**限制（注释：导航可离开 cwd），`write` 也故意不限制——我们不照搬 | filesystem.ts L169、L201 |
| 模糊找 | 用 ripgrep `--files` 建一次全量索引（默认遵守 .gitignore、跳过隐藏文件），内存里用 `fuzzysort` 打分，默认 50 条；家目录上限 10 万条并排除受保护目录 | [core/filesystem/search.ts](https://github.com/sst/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/core/src/filesystem/search.ts)、[core/ripgrep.ts](https://github.com/sst/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/core/src/ripgrep.ts)、[filesystem/protected.ts](https://github.com/sst/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/core/src/filesystem/protected.ts) |
| 变化 | 文件监听（watcher）推事件，前端失效缓存 | [app/workspaces/files/watcher.ts](https://github.com/sst/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/app/src/workspaces/files/watcher.ts) |
| 前端缓存 | 文件内容 LRU：最多 40 个、20 MB | [content-cache.ts](https://github.com/sst/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/app/src/workspaces/files/content-cache.ts) |
| 树组件 / 高亮 / diff | `@pierre/trees`（树）、`@pierre/highlights`（Shiki 系高亮）、`@pierre/diffs`（diff，带虚拟滚动） | [app/package.json](https://github.com/sst/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/app/package.json)、[session-ui/src/pierre/virtualizer.ts](https://github.com/sst/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/session-ui/src/pierre/virtualizer.ts) |
| git | `vcs.status`、`vcs.diff`（mode、context、base、untracked）给「改动审查」视图；非 git 目录有专门空态 | [server/handlers/vcs.ts](https://github.com/sst/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/server/src/handlers/vcs.ts)、[session-review-v2.tsx](https://github.com/sst/opencode/blob/69269e4ebe309a08919b3c9be7948b9fd699c3a4/packages/session-ui/src/v2/components/session-review-v2.tsx) |

## 3. agent-hub 现状

- 工作空间在 Worker 上（`Workspace { workerId, path }`，docs/design/workspaces.md），hub 经长连接 RPC 调 Worker。
- 已有 RPC：`fs.list_directories`（只列目录）、`fs.list_files`（广度优先、跳点目录和 node_modules 等，给 @ 引用用）、`fs.read_file`（base64，带 maxBytes）、`ws.status`（只有 dirty/untracked/unpushed 计数）。见 `packages/contract/src/worker-methods.ts`、`packages/node-gateway/src/worker-fs-rpc.ts`。
- 边界：`WorkerFiles.check()` 用 realpath 校验在 `WORKER_ROOTS` 内（`node-gateway/src/worker-files.ts`）。
- 端口：`domain/ports/workspace-fs.ts`、`workspace-git.ts`；授权 `can()` 已能从 workspace 解析到项目（`use-cases/authorization.ts`）。
- 会话 → 工作空间：`sessions.workspace_id` → 工作空间 path + workerId。

## 4. 设计

### 4.1 范围（分阶段）
- **P1 只读**：目录树（懒加载）、模糊找文件、文件查看（高亮、图片预览、二进制只显示信息）、git 状态标记、单文件 diff 和「本会话改动」列表、下载单个文件。
- **P1 含实时刷新**（D3）：见 §4.9。
- **P2**：全文搜索（ripgrep）。
- **P3（待定）**：编辑/上传/删除——和 agent 同时写有冲突风险，需要另行设计。

### 4.2 传输（hub → Worker RPC，新增 4 个方法，contract 里定义）
| 方法 | 入参 | 出参 |
|---|---|---|
| `files.list` | workspaceId 对应的 root、相对 path | 条目 {name, type, size, mtime, ignored, git} ，截断 1000 条 |
| `files.read` | root、path、offset、maxBytes(≤1 MB) | {data(base64), size, mime, binary, truncated, etag} |
| `files.find` | root、query、limit(≤50) | [{path, type}]；Worker 用 ripgrep --files 建索引 + fuzzysort（同 opencode） |
| `git.changes` / `git.diff` | root、[path]、base | 改动列表(状态 M/A/D/R/?)/统一 diff 文本(≤512 KB) |

**路径只传相对 root 的路径**，hub 从工作空间记录里拿 root，前端永远拿不到绝对路径参数。Worker 侧：拒 NUL、拒绝绝对路径和 `..`，resolve 后 + realpath 后都必须在 root 内且在 WORKER_ROOTS 内（比 opencode 严：list 也限制）。错误一律「不存在」。

hub 侧新增端口 `WorkspaceBrowser`（domain/ports），适配器走 NodeGateway；本机 Worker 同一实现。HTTP：`GET /api/workspaces/:id/files?path=`、`/files/content?path=`（支持 ETag/304）、`/files/find?q=`、`/git/changes`、`/git/diff?path=`、`/files/download?path=`。

### 4.3 权限
新增 `workspace.files.read`（读树/内容/diff），默认授予拥有 `project.read` 的角色？——见决策 D2。下载复用同一权限并记审计。所有访问经 `can()` 按 workspace → 项目解析。

### 4.4 忽略规则
默认遵守 .gitignore（ripgrep 原生）；被忽略的条目树里**灰显可展开**（不藏起来，方便看 dist 产物），模糊找默认不搜；`.git/` 永远不列。另有一份「敏感文件」名单（`.env*`、`*.pem`、`id_rsa*`、`*.key`）内容默认不给看——见决策 D4。

### 4.5 限制
单文件预览 1 MB（超出给「下载」按钮）；二进制（含 NUL 或 MIME 非文本）不渲染；目录单层 1000 条；模糊找 50 条；diff 512 KB；每用户每秒 20 次请求；RPC 超时 10 秒。

### 4.6 查看器
- 高亮用 **Shiki**（成熟、VS Code 同款语法，懒加载语言包；opencode 也是 Shiki 系）。
- diff 用 **@pierre/diffs**（opencode 同款）或 `diff2html`——见决策 D5。
- Markdown 默认渲染、可切源码；图片直接预览。
- 大文件虚拟滚动。

### 4.7 移动端（390px）
列表钻取：一层目录一屏，顶部面包屑 + 搜索框；点文件全屏查看，顶部「返回 / 文件名 / ⋯（下载、复制路径、看 diff）」；底部分段切「文件 | 改动」。代码默认不折行可横滑，可切折行。桌面：左树右文件，上方 tab「文件 | 改动(n)」。

### 4.8 入口
会话详情加「文件」页签（定位到会话的工作空间），工作空间列表每项加「浏览」。

### 4.9 实时监听（D3）
- Worker：chokidar，`depth: 0`，`ignoreInitial`，忽略 `.git/` 和 .gitignore 命中的路径；按工作空间合并事件，防抖 300 ms 后发一条 `files.changed {workspaceId, paths[]}`。
- 只监听浏览器订阅的「已展开目录 + 打开的文件」，引用计数，最后一个订阅者走后 30 秒释放；每工作空间上限 200 个点，超出回「太多，请手动刷新」。
- hub：`files.watch / files.unwatch` RPC；浏览器经 SSE `GET /api/workspaces/:id/files/events?paths=` 订阅，断线（浏览器或 Worker）后重新订阅并整体刷新。
- 会话每轮结束也触发一次刷新兜底。

## 5. 定稿决策
见 ADR 0025「定稿」节。

## 6. 草图
`docs/design/mockups/workspace-files/index.html`（390px 与桌面截图在 PR 里）。
