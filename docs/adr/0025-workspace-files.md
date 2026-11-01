# ADR 0025：工作空间文件浏览（参考 opencode 网页端）

- 状态：proposed（2026-11-01）
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

## 待定（每项：选项 → 推荐）

- D1 范围：只读 / 只读+下载 / 含编辑上传 → **只读+单文件下载**
- D2 权限：复用 `project.read` / 新增 `workspace.files.read` 默认随 project.read 授予 / 新增且默认只给 owner、管理员 → **新增权限，默认随 project.read 授予**（可单独收回）
- D3 实时刷新：P1 手动刷新 / P1 就做监听推送 → **P1 手动刷新 + 会话每轮结束自动刷新，监听放 P2**
- D4 敏感文件（.env、密钥）：照常显示 / 名单内默认遮住、有权限者点开并审计 / 完全不给看 → **默认遮住，点开记审计**
- D5 diff 组件：@pierre/diffs（opencode 同款，beta）/ diff2html（成熟）/ 自己用 Shiki 渲染 → **diff2html**（成熟稳定，后续可换）
- D6 忽略文件：隐藏 / 灰显可展开 → **灰显可展开**
- D7 diff 基准：工作区 vs HEAD / vs 会话开始时的提交 / 两者可切 → **两者可切，默认会话开始时**（需在会话开始时记下 HEAD）
- D8 Worker 离线：报错 / 显示上次缓存 → **报「Worker 离线」不缓存**（避免看到过期内容）
