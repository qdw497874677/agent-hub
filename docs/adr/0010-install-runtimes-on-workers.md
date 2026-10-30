# 10. 从 hub 给 Worker 安装运行时

Status: proposed（草案，待 David 确认 docs/design/runtime-install.md 里的待决问题）

## 背景

Worker 上的 Pi / OpenCode / Grok 只能由人登录到机器上手动安装，界面上只能看到「未安装」。aliyun 上 server 自带的 Worker 就缺 OpenCode。

## 决定

1. 在 Worker 侧为每个运行时新增一个 `HarnessInstaller` 适配器（和 `HarnessReadiness` 放在一起）。安装内容写死在适配器里（包名、来源、参数），hub 只传 `agentId + version`。
2. 只装进 `~/.agent-hub/runtimes/<agent>/<version>`：先装进 staging，验证后原子切换 `current`。不写全局 npm、不改 shell 配置、不用 sudo。命令解析新增 `managed` 来源。
3. 任务走现有 WS（新增 `runtime_job*` 帧），日志实时推到界面。结束后 Worker 自动重新探测。
4. 版本按机器钉住；查到新版本只标「可升级」，在界面上看过版本差异、确认后才升级。
5. 只有主人能操作，每次操作写审计。
6. 登录永远由用户在那台机器上手动完成，hub 不经手凭据，界面只给登录提示。

## 后果

- 同一台机器上可能同时存在「hub 安装的」和「用户自己装的」两份，探测结果和界面要显示用的是哪一份。
- Grok 只有官方脚本这一种安装方式，依赖它的参数（`GROK_BIN_DIR`、指定版本）保持稳定；脚本一改就要跟着改。
- 协议新增帧，前后端和 Worker 要一起发布；旧 Worker 解析不了新帧，只会记一条日志、不回复，所以 hub 要按 Worker 版本判断能不能装（太旧的提示先更新 Worker）。
