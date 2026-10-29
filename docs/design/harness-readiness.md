# Harness 就绪探测

## 问题

以前 Worker 只看命令是否存在就报告自己有哪些 harness（Pi / OpenCode / Grok）。比如 omarchy 装了 Grok 但没登录，hub 仍把它当成可用，会话要到运行时才失败。

## 目标

- 每个 harness 报告 `ready`，或者报告 `unavailable` 并附中文原因（未安装 / 未登录 / 未配置模型 / 检测超时 / 检测失败）。
- 三个时机会重新探测：连上 hub 时、定时（默认 5 分钟，可用 `HARNESS_PROBE_INTERVAL_MS` 调）、用户点「重新检测」时。
- 界面上，不可用的 harness 显示为灰色并写明原因，落点也不会选它。
- 老 Worker 或老 hub 不需要升级就能正常工作：没报 readiness 一律当作能用。

## 分层（六边形）

```
domain                ports/harness-readiness.ts   HarnessReadiness { agentId; probe(): HarnessProbe }
                      worker.ts                    AgentReadiness = ready | unavailable(reason)
                                                   placeSession 跳过 unavailable；harnessUnavailableReason()
                      use-cases/workers.ts         probeWorker（「重新检测」用例，经 NodeGateway.probe?）
adapters（每个 runtime 一个，和 runtime 放在一起，用同一条命令 / 环境变量）
  adapter-pi          readiness.ts   pi --version → 未安装；列不出模型 → 未配置模型
  adapter-acp         readiness.ts   命令不在 → 未安装；listModelsArgs 列不出 → 未配置模型（OpenCode 等）
  adapter-grok        readiness.ts   grok models → 首行判断是否登录；有 XAI_API_KEY 也算能用
node-gateway          command-resolver.ts  解析 harness 命令：显式 X_COMMAND → PATH → 常见目录兜底 → missing（纯函数，不起登录 shell）
                      harness-registry.ts  组合任意多个 HarnessReadiness：各自超时 / 兜底、并发合并；withMissingHint 给「未安装」附提示
                      worker-link.ts       连上 / 定时 / probe 指令时跑注册表，把 readiness 叠到 agent 清单上，
                                           经 `agents` 帧上报
                      server-gateway.ts    收 `agents` 帧后替换清单；requestProbe 下发 `probe`；不认识具体 harness
contract              agentSchema.readiness?、workerInfo.agentModels[].readiness?、admin harnesses[]
                      worker→server `{type:'agents'}`、server→worker `{kind:'probe'}`（都是增量，协议版本不变）
apps/worker           组合根：runtimes 旁边列出各自的 readiness 适配器
apps/server           onAgents → catalog.upsert；POST /api/workers/:id/probe
apps/web              harness.tsx：只读统一的 readiness（HarnessBadges / RecheckButton / harnessReason）
```

加一个 harness 只需要两步：写它的 runtime 和 `readiness.ts`，再在 apps/worker 的组合根里各加一行。hub 和 web 都不用改。

`scripts/check-import-boundaries.mjs` 新增了两条文件规则：

- `harness-registry.ts` 只许 import 相对路径和 `@agent-hub/domain`。
- 各适配器的 `readiness.ts` 不得 import 传输层。

## 探测的约束

- **便宜且无副作用。** 只用 `--version`、`models` 这类本地命令，不登录、不改配置、不开会话。
- **超时与隔离。** 每个探测有自己的超时；注册表外层还有一道超时兜底。一个 harness 卡住不会拖累别的。
- **不泄露信息。** 原因只取固定的中文短句，不带命令输出（输出里可能有 token 或路径）。

## 命令解析

worker 组合根对每个 harness 只解析一次命令，runtime 和 readiness 用同一个结果：

1. 设了 `PI_COMMAND` / `OPENCODE_COMMAND` / `GROK_COMMAND` 就直接用。
2. 否则在 PATH 里找。
3. 还找不到就去常见目录兜底；命中时把那个目录补到进程 PATH 前面（让 `#!/usr/bin/env node` 和子进程也能用），并打一行日志。
4. 都没有：readiness 为「未安装」，附 `hint`「PATH 里找不到 X，可设 X_COMMAND 指定路径」，界面显示在原因下面。

运行时和探测时都不起登录 shell；登录 shell 只在 `install-worker.sh` 安装时跑一次，结果持久化到 worker.env 的 `PATH`。

## 兼容性

| 组合 | 行为 |
| --- | --- |
| 新 Worker + 老 hub | 老 hub 收到 `agents` 帧时只记一条「无法解析的帧」日志；hello 里的 readiness 字段会被 zod 丢弃。 |
| 老 Worker + 新 hub | 不报 readiness，等同 ready；收到 `probe` 指令只记日志。「重新检测」相当于什么都不做。 |
