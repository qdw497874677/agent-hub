# 会话服务（本地长驻进程）

> 状态：设计，未实现。前置：`docs/design/session-pin.md`（会话常驻，已完成）。

## 1. 问题

任务是长期载体，会话是执行单元。用户想让「一个会话长期跑本地项目」（dev server、watcher、数据库），
但会话不是进程管理器：

- 回合结束后 Worker 保活进程，闲置 15 分钟回收（`HUB_SESSION_IDLE_MS`），保活上限 8（`HUB_KEEPALIVE_MAX`）。
- `pinned` 会话不回收、不占上限，但只保证 **agent 进程** 在；会话里用 `setsid nohup` 起的服务
  活不过 Worker 重启（systemd `KillMode=control-group` 会清 cgroup）。
- 谁在跑、跑在哪个端口、日志在哪，hub 不知道；预览链接要人肉填端口。

结论：需要 Worker 侧的「服务」原语——由 hub 记账、Worker 执行、可在重启后按记录重拉。

## 2. 目标 / 非目标

目标：

- 一条命令声明一个长驻服务（cwd、命令、端口、环境变量白名单），由 Worker 托管。
- 状态（starting/running/failed/stopped）与日志尾部在 hub 可见，任务页能看到「这个任务起了哪些服务」。
- 预览可以按服务名建链接（端口来自服务，不用人填）。
- Worker 重启后按记录重新拉起（`restart: 'always' | 'on-demand' | 'never'`），失败给出原因。

非目标（v1）：

- 不做容器/资源隔离、不做自动缩容、不做跨机迁移。
- 不做「服务写入」的反向代理替换（预览仍是端口映射）。
- 不允许服务命令来自不可信来源（外部 MCP 只读；建服务需会话写权限 + 项目成员）。

## 3. 数据模型

```ts
export interface SessionService {
  readonly id: ServiceId;            // svc_<8hex>
  readonly projectId: ProjectId;
  readonly taskId: TaskId | null;
  readonly workspaceId: WorkspaceId | null;
  readonly sessionId: SessionId | null; // 从哪条会话发起（可空）
  readonly workerId: string;
  readonly root: string;             // 绝对路径，必须在 WORKER_ROOTS 内
  readonly command: string;          // /bin/sh -lc，长度 ≤ 2000
  readonly port: number | null;      // 1024–65535，null = 未声明
  readonly env: Readonly<Record<string, string>>; // 白名单键，≤ 20 个
  readonly restart: 'always' | 'on-demand' | 'never';
  readonly state: 'starting' | 'running' | 'failed' | 'stopped';
  readonly pid: number | null;       // running 时才有
  readonly detail: string | null;    // failed 时的原因；stopped 的退出码
  readonly startedAt: number | null;
  readonly updatedAt: number;
}
```

存储：`session_services`（上表列 + `log_tail TEXT` 最近 8 KiB）。`state` 只由 Worker 上报推进，
hub 不做乐观状态（避免「显示 running 实际已死」）。

## 4. 协议

新增 capability `'service'`（`packages/domain/src/worker-capability.ts`），协议 v6。

Worker 方法（hub → worker，返回结果）：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `ws.service.start` | `{ serviceId, root, command, port?, env?, restart }` | `{ pid, port? }` |
| `ws.service.stop` | `{ serviceId, signal?: 'TERM'\|'KILL' }` | `{ exited: boolean }` |
| `ws.service.list` | `{}` | `{ services: [{ serviceId, pid, state, port? }] }` |
| `ws.service.logs` | `{ serviceId, maxBytes? }` | `{ tail: string }` |

Worker 事件（worker → hub）：`service_state` `{ serviceId, state, pid?, detail?, port? }`、
`service_log` `{ serviceId, chunk }`（节流 500ms，只在有订阅者或服务开了「日志进 hub」时发）。

启动规则：

- `root` 必须 realpath 后落在 `WORKER_ROOTS` 内；`command` 与 `env` 过与 setup 相同的白名单与凭据抹除。
- 用 `spawn('/bin/sh', ['-lc', command], { cwd: root, detached: true, stdio: ['ignore','pipe','pipe'] })`，
  `detached` 让服务有独立进程组（`process.kill(-pid)` 停整棵树）。
- `port` 声明后，Worker 在 30 秒内轮询 `/proc/net/tcp` 等它监听，成功即 `running`；超时 `failed('30 秒内没有监听端口')`。
- 服务进程退出：`restart === 'always'` 时退避重拉（1s/5s/30s，上限 5 次），其它情况 `stopped`/`failed`。
- Worker 重启：读本地 `services.json`（`<root>/../.agent-hub/services.json`），按 `restart` 决定是否重拉；
  hub 重连后用 `ws.service.list` 对账，找不到的标 `failed('机器重启后没有拉起来')`。

## 5. 权限与审计

- 建/停服务：`session.prompt` 或 `project.update`（同项目成员）；`root` 必须在项目工作空间内或 WORKER_ROOTS 内。
- 审计：`service.start` / `service.stop`（detail 带 command 前 200 字与 port）。
- 外部 MCP：v1 只读（`list_services`、`get_service`）；写留给后续（需要 `sessions:write` + 明确项目成员身份）。
- 令牌与秘密：`env` 只接受显式传入的键；不允许 `${secret:…}` 在服务层展开（避免秘密长期驻留进程环境之外的日志）。

## 6. 与预览、任务的关系

- 预览：`PreviewLink.source: 'manual' | 'detected' | 'service'`；服务有 `port` 时建链接可只选服务，
  hub 写 `port` 与 `serviceId`，`onPorts` 按服务状态判断 `ready`/`stale`。
- 任务：任务详情「本地服务」卡列出该任务的 `session_services`，可启动/停止/看日志尾。
- 会话：会话头「服务 2」chip，点开同一列表；删除服务不删会话，删除会话可保留服务（显式选择）。

## 7. 分期

- **S1**：协议 + Worker 原语（start/stop/list/logs、状态事件、重启重拉）+ storage + HTTP 路由 + 单测/假 agent 测试。
- **S2**：任务页与会话头 UI；预览按服务建链接；审计与权限收口。
- **S3**：外部 MCP 只读工具、日志流式订阅、健康检查（HTTP 探活）与自动重启策略细化。

## 8. 验收

1. 会话里经 hub 起一个 `vite --port 8130` 服务，`state` 30 秒内变 `running`，预览链接自动出现并可打开。
2. `systemctl --user restart agent-hub-worker` 后，`restart: 'always'` 的服务自动重拉，hub 状态回到 `running`，
   日志尾部保留；`on-demand` 的服务标 `failed('机器重启后没有拉起来')` 并可由用户一键重启。
3. 服务进程崩溃（`kill -9`）时 `restart: 'always'` 在 5 秒内重拉，`detail` 记录退出码；超过 5 次标 `failed`。
4. 路径逃逸（`root='/etc'`）、命令带 `HUB_TOKEN`、端口不在 1024–65535 → 400 且不 spawn。
