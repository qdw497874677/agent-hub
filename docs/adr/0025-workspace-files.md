# ADR 0025：工作空间文件浏览（参考 opencode 网页端）

- 状态：accepted（2026-11-01 David 在决策卡里定了 D1–D8）
- 相关：ADR 0013、docs/design/workspaces.md、docs/design/workspace-files.md

## 决定（草案）

1. P1 只读：懒加载目录树、模糊找文件、高亮查看、git 改动 + diff、单文件下载。编辑/上传放 P3 另议。
2. hub 经 Worker RPC 新增 `files.list / files.read / files.find / git.changes / git.diff`；前端只传相对路径，root 由 hub 从工作空间记录取。
3. Worker 侧路径校验：拒 NUL/绝对路径/`..`，resolve 和 realpath 都必须在工作空间 root 与 WORKER_ROOTS 内；list 也校验（不同于 opencode）。错误统一「不存在」。
4. 限制：预览 1 MB、目录 1000 条、找文件 50 条、diff 512 KB、RPC 10 秒、每用户 20 次/秒。
5. 默认遵守 .gitignore，忽略项灰显；`.git/` 不列。
6. 高亮用 Shiki，懒加载语言。
7. 移动端列表钻取 + 全屏查看；桌面左树右文。
8. 新端口 `WorkspaceBrowser`，适配器走 NodeGateway。

## 定稿（2026-11-01 David）

- D1：只读 + 单文件下载；编辑/上传放 P3。
- D2：新增 `workspace.files.read`，随 `project.read` 默认授予，可单独收回。
- D3：**P1 就做实时监听**：Worker 用 chokidar 监听，防抖 300 ms，遵守忽略规则；只监听已展开的目录（depth 0）和打开的文件，每个工作空间最多 200 个监听点；事件经现有 hub↔Worker 长连接推给已订阅的浏览器（SSE）；断线重连后重新订阅并整体刷新。
- D4：敏感文件（`.env*`、`*.pem`、`*.key`、`id_rsa*`、`id_ed25519*`、`*.p12`）内容默认遮住，点开要显式确认，记审计 `workspace.files.sensitive`。
- D5：diff 用 diff2html。
- D6：被忽略的条目灰显、可展开。
- D7：diff 基准可切；默认对比「会话开始时的 HEAD」（会话开始时记下），没有记录时退回 HEAD。
- D8：Worker 离线显示「Worker 离线」，不缓存。
