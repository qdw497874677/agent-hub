# 用 `ahub` 从终端驱动 agent-hub

需要包含 `scripts/ahub.ts` 的 agent-hub 源码、Node.js 26，以及支持相应 CLI 能力的 Hub。当前没有独立安装包；运行以下命令不需要在客户端安装 Agent。会话仍在 Hub 授权的远程 Worker 上执行。

## 1. 登录

在 Hub 的「外部接入」签发短期访问令牌，勾选「只给指定项目」。只盘点就用只读令牌；要建任务和开会话，可用「委派开发」预设，或自定义授予 `projects:write` 和 `sessions:write`（如要用 Hub 提供商模型，再授予 `providers:use`）。这是接入令牌，不是 Git 仓库凭证。

从源码目录运行，按提示输入令牌，终端不回显：

```sh
node scripts/ahub.ts auth login --hub https://hub.example.com --profile work
node scripts/ahub.ts auth status --profile work
```

HTTP 只允许显式使用 `--allow-http` 的本机回环地址；不要在公网 HTTP 上发送令牌。没有 HTTPS 时，可由管理员提供可信隧道的本地回环入口。非交互程序通过秘密管理器成对注入 `AHUB_HUB_URL`、`AHUB_API_TOKEN`，并省掉 `--profile`，不会保存环境令牌。也可让 `auth login --token-stdin` 从管道接收并保存；不要把明文写进命令、历史记录或日志。`auth logout` 只清除本机 profile；要让令牌彻底失效，在 Hub 吊销。

## 2. 选择目标、启动与发送

在普通终端里可以按编号选择，不用复制项目、任务、机器或目录 ID。确认前不会创建任务或启动会话；输入 `0` 或在确认时直接按回车即可取消。

```sh
node scripts/ahub.ts task create --title '检查构建问题' --profile work
node scripts/ahub.ts session start --profile work
```

启动会依次让你选项目、任务、远程 Worker、工作目录、Agent 和模型。没有可用目录时先到 Hub 登记；CLI 不自动下载仓库、装运行时或换机器。

非交互环境或 `--json` 模式不弹选择器，请显式传入完整 ID：

```sh
node scripts/ahub.ts project list --profile work
node scripts/ahub.ts task list --project "$PROJECT_ID" --profile work
node scripts/ahub.ts task create --project "$PROJECT_ID" --title '检查构建问题' --profile work
node scripts/ahub.ts doctor --task "$TASK_ID" --profile work
node scripts/ahub.ts session start --task "$TASK_ID" --worker "$WORKER_ID" \
  --workspace "$WORKSPACE_ID" --agent "$AGENT_ID" --profile work
node scripts/ahub.ts session show "$SESSION_ID" --profile work
node scripts/ahub.ts session send "$SESSION_ID" --stdin --wait --timeout 180 --profile work < prompt.txt
node scripts/ahub.ts task show "$TASK_ID" --profile work
```

- `doctor` 列出远程 Worker、目录、Agent 和可见的模型信息；它不预留资源。用显式参数启动时，`--model` 省略则由 Hub 解析默认模型；找不到就要求显式指定。
- `registered` 表示会话已登记，不保证运行时已经就绪。`accepted` 表示 Hub 已收件，不代表送达或完成；`--wait` 的 `done` 才是该次投递的已确认结果。`task show` 展示已有会话和 PR，不替你创建 PR。
- 等待到期或按 Ctrl-C，不会取消 Hub 中的工作。用 `session wait "$SESSION_ID" --turn "$TURN" --profile work` 继续查询同一轮；如果状态是 `unknown`，**不要重新发送**。

## 3. 给脚本和排查用

加 `--json` 后，stdout 是一个带 `schemaVersion: 1` 的 JSON 对象。检验 `status` 和退出码：`0` 成功（有等待时表示这一轮已确认完成），`2` 用法／配置，`3` 授权，`4` 已确认非成功结果，`5` 等待到期，`6` 无法确认或 Hub 不支持，`130` 仅本机取消选择或中断等待。自动化脚本不要解析中文提示。

丢失写回执就用 `node scripts/ahub.ts operation status "$OPERATION_ID" --profile work` 查看**这台机器**的记录。它不重发写请求；查不到记录也不是「未执行」的证据。保留操作、会话和回合 ID，回 Hub 核对。当前没有 `operation retry`。

如果你维护的是 REST/MCP 客户端：外部 SSE 暂停，时间线改用 [`events` / `nextAfter`](../../openapi/v1.json)；精确结果用 `GET /openapi/v1/sessions/{sessionId}/turns/{turn}` 或工具 `get_session_turn`。不要用时间线中 `ended.turn` 代替投递身份。协议与取舍见 [实施计划](cli-plan.md)。
