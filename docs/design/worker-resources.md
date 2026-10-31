# Worker 上报机器资源占用（设计稿）

- 状态：**草案，待拍板**（见 §12 决策问题）。本 PR 只写设计，不实现。
- 相关：ADR 0001（六边形）、ADR 0011（团队 RBAC）、`docs/design/worker-enrollment.md`、ADR 0014（本稿配套，proposed）

## 1. 背景与目标

现在 hub 对 worker 只知道「在不在」：`server-gateway.ts` 每 `heartbeatMs` 发一次 WebSocket `ping`，下一轮没收到 `pong` 就判离线；`worker-link.ts` 侧用 `heartbeatTimeoutMs`（默认 30 s）看门狗发现半开连接。ping/pong 不带任何负载。

David 希望能看到每台机器的资源占用，回答这几个问题：

1. 这台机器还扛得住再开一个会话吗？（内存 / CPU / 磁盘）
2. 哪条会话的 agent 在吃资源？（会话级进程树 CPU / RSS）
3. 机器快满了能不能提前知道？（阈值提醒，可选拒绝新会话）

非目标：通用监控系统（Prometheus / Grafana 替代品）、长期历史与报表、远程杀进程。

## 2. 采什么

| 层级 | 指标 | 说明 |
|---|---|---|
| 机器 | CPU 使用率 %（全核平均）、核数、load average 1/5/15 | Windows 无 loadavg，报 null |
| 机器 | 内存 total / available（不是 free）、swap used | Linux 用 `MemAvailable`，否则缓存会让「free」看起来很吓人 |
| 机器 | 磁盘：每个 **workspace root**（hello 里已有的 `roots`）所在文件系统的 total / free | 按挂载点去重；不扫整机所有盘 |
| 机器 | uptime | 便于认出「刚重启过」 |
| 会话 | 该会话 agent **进程树**（根 pid 及所有子孙）的 CPU %、RSS 合计、进程数 | agent 常起子进程（shell、LSP、node），只看根 pid 会严重低估 |
| 可选 | GPU：利用率、显存 used/total | 默认关闭；只在探测到 `nvidia-smi` 时启用，见 §3 |

不采：进程命令行、环境变量、文件名（避免把密钥或私有路径带上 hub；ADR 0013 的「密钥不进 argv」只是约束我们自己，第三方进程的 argv 我们不读）。

## 3. 怎么采：库 vs `node:os`

| 方案 | 优点 | 缺点 |
|---|---|---|
| `node:os` + `fs.statfs` | 零依赖；`os.loadavg()`、`os.totalmem()`、`os.cpus()`（两次采样差值算 CPU%）、`fs.statfs`（Node ≥18.15）够用 | `os.freemem()` 在 Linux 是 MemFree 不是 MemAvailable；没有进程树、没有 GPU |
| `pidusage` | 成熟、轻量，按 pid 取 CPU%/内存，跨平台 | 只管给定 pid，进程树要自己枚举 |
| `pidtree` | 枚举子孙 pid，配合 pidusage | 每次 `ps` / 读 `/proc`，进程多时有开销 |
| `systeminformation` | 全家桶：内存 available、磁盘、GPU、进程列表 | 体积大；很多函数背后是 `exec` 子进程（`df`、`nvidia-smi`、PowerShell），默认间隔下开销明显 |

**推荐**：机器级用 `node:os` + `fs.statfs`，Linux 上额外读 `/proc/meminfo` 拿 `MemAvailable`；会话级用 `pidtree` + `pidusage`（Linux 上二者都读 `/proc`，不起子进程）。GPU 可选：只在开关打开且 `nvidia-smi` 存在时，用 `nvidia-smi --query-gpu=... --format=csv` 低频采。不引入 `systeminformation`（成本见 §10）。

采集全部藏在适配器后面（§5），换库不影响 domain 和协议。

## 4. 采样与传输

### 4.1 频率
- 机器级：每 **15 s** 采一次（CPU% 用两次 `os.cpus()` 的差值，天然就是「这 15 s 的平均」）。
- 会话级：同一节拍，只对**正在托管**的会话采；没有会话就不枚举进程。
- 磁盘：每 **60 s**（变化慢，`statfs` 虽便宜也没必要更频）。
- GPU：每 60 s（`nvidia-smi` 是子进程）。
- 有人在看时加速？v1 不做（需要 hub→worker 订阅信令，复杂度不值）。

### 4.2 随心跳还是单独消息
现在的心跳是 WS 协议层 ping/pong，**不能**带应用负载（pong 只回显 ping 的 payload，由 server 发起）。因此「随心跳」实际意味着改成应用层心跳，牵连离线判定逻辑，风险大。

**推荐**：新增 worker→server 帧 `{ type: 'metrics', at, machine, sessions[] }`，worker 按自己的节拍主动发；离线判定继续用 ping/pong，两者解耦。

```ts
// packages/contract/src/wire/worker.ts（示意）
export const workerMetricsSchema = z.object({
  type: z.literal('metrics'),
  at: z.number(),                         // worker 本地 epoch ms，hub 以收到时间为准排序
  machine: z.object({
    cpuPercent: z.number().min(0).max(100), cores: z.number().int(),
    load: z.tuple([z.number(), z.number(), z.number()]).nullable(),
    memTotal: z.number(), memAvailable: z.number(), swapUsed: z.number().nullable(),
    disks: z.array(z.object({ root: z.string(), total: z.number(), free: z.number() })).max(16),
    gpus: z.array(z.object({ name: z.string(), util: z.number(), memUsed: z.number(), memTotal: z.number() })).max(8).optional(),
    uptimeSec: z.number()
  }),
  sessions: z.array(z.object({ sessionId: id, cpuPercent: z.number(), rss: z.number(), processes: z.number().int() })).max(256)
});
```

### 4.3 版本与兼容
- `server-gateway.ts` 对解析不了的帧只记日志、丢弃，不断连。所以：**新 worker → 老 hub**：`metrics` 帧被丢弃（日志会刷，见下）；**老 worker → 新 hub**：不发 metrics，界面显示「这台 worker 版本不报资源」。
- 不升 `PROTOCOL_VERSION`（目前 2）：升版本会让 enroll / hello 版本不匹配时直接断连（`PROTOCOL_MISMATCH_CLOSE`），为一个可选功能让老 worker 全部下线不划算。
- 改为**能力协商**：hello 里加 `capabilities: ['metrics']`（可选字段，老 hub 的 zod 默认会剥掉未知字段，不报错）；hub 在 `hello` 回执里回 `accepts: ['metrics']`，worker 只在对方声明接受时才发，避免往老 hub 刷日志。
- 帧大小：sessions 上限 256、disks 上限 16，单帧 < 32 KiB。

## 5. 六边形分层

```
domain                         adapters / node-gateway                  server
─────────────────────────────  ──────────────────────────────────────   ─────────────────────────────
port ResourceProbe             NodeResourceProbe（os+statfs+/proc）     MetricsStore（port）
  machine(): MachineSample       + ProcessTreeProbe（pidtree+pidusage）    InMemoryMetricsStore
  sessions(pids): SessionSample  + GpuProbe（nvidia-smi，可选）             SqliteMetricsHistory（可选）
值对象 MachineSample /          worker-link.ts：定时调 probe → 发帧     use case: RecordMetrics /
  SessionSample / Threshold      会话 → 根 pid 的映射由 runtime 宿主提供   QueryMetrics（带 RBAC）
策略 assessPressure(sample,                                              admission: canStartSession
  thresholds) → ok|warn|full                                              读 assessPressure
```

- domain 只放纯类型、阈值判定 `assessPressure` 和端口接口，零 I/O，可单测。
- `ResourceProbe` 在 worker 进程里实现；hub 侧不采集（hub 自己的本机 worker 也走同一路径）。
- 会话 → pid：runtime 宿主启动 agent 时已持有子进程句柄，暴露 `pidOf(sessionId)` 给 probe；不靠扫描进程名猜。
- 契约测试：probe 的 conformance 套件（数值范围、空会话、进程已退出时不抛）。

## 6. hub 存储

| 方案 | 用途 | 代价 |
|---|---|---|
| 内存：每台 worker 最新一帧 | 机器列表、卡片徽标、准入判断 | 几 KB / worker，重启即丢（worker 15 s 内补上） |
| 内存环形缓冲：最近 1 h（240 点 / worker） | 小走势图（sparkline） | 每 worker 约 240 × ~0.5 KB ≈ 120 KB |
| SQLite `worker_metrics`：降采样到 1 分钟，保留 24 h | 重启后还能看昨晚怎么了 | 写放大；需要定时清理 |

**推荐 v1**：只做内存（最新 + 1 h 环形缓冲），不落库。会话级只保留最新值。v2 若有需要再加 SQLite 降采样表（`worker_id, minute, cpu_avg, cpu_max, mem_min_available, disk_min_free`，保留 24 h，每小时 `DELETE ... WHERE minute < ?`），不进备份关键路径。

## 7. RBAC 可见性

沿用 ADR 0011 的 `worker.read`：

- 机器级指标：能看到这台 worker（`worker.read`，team 作用域）的人就能看到它的资源。
- 会话级指标：跟会话走——能看到这条会话的人才看得到它的进程占用；看得到机器但看不到会话的人，只看到机器合计和「其他会话 N 个」。
- 磁盘：只回 root 的**显示名**（和目录选择器同一套），不回给没有 `worker.use` 的人完整路径。
- 阈值配置：`worker.manage`。
- 管理员（hub 级）看全部。
- API：`GET /api/workers` 的每项附 `resources: {...} | null`（最新值）；`GET /api/workers/:id/metrics?window=1h` 取走势；会话的走 `GET /api/sessions/:id` 附 `usage`。实时更新复用现有 SSE 流，加 `worker_metrics` 帧，**按订阅者权限过滤后**再推。

## 8. 界面

- **机器列表**（管理页 / worker 选择器）：每行 CPU %、内存「已用 / 总量」、最紧的那块盘的剩余；超阈值时整行出现黄/红标；点开看 1 h sparkline。手机上折成两行：名字 + 状态 / 三个小条。
- **画布 worker 框**：框标题右侧一个小徽标 `CPU 37% · 内存 62%`，警告时变色；手机上只显示一个圆点（绿/黄/红），点一下弹出详情。
- **会话卡片 / 窗口**：状态胶囊旁可选显示 `◔ 12% · 480M`（进程树合计），只在会话运行中显示；卡片窄时只显示 RSS。设置里可关。
- **新建会话 / 选 worker**：选择列表里显示同样的三项，满载的 worker 标灰并说明原因（若启用拒绝策略）。
- 数字统一 1 位小数、二进制单位（MiB/GiB），无数据显示「—」而不是 0。

## 9. 阈值与提醒

默认阈值（可按 worker 覆盖，`worker.manage`）：

| 指标 | 警告 | 满载 |
|---|---|---|
| 内存 available | < 15% | < 5% |
| workspace root 磁盘 free | < 10% 或 < 5 GiB | < 2% 或 < 1 GiB |
| CPU（连续 4 个采样 = 1 min） | > 90% | — |

- 警告：界面变色 + 画布顶栏提示一次（不轰炸，状态变化才提示）。
- 满载：**默认只提示**；可选开关「满载时拒绝在这台 worker 上新开会话」，拒绝时明确说明原因（「磁盘只剩 0.8 GiB」），已在跑的会话不受影响。
- 连续 3 帧都超才算进入状态、连续 3 帧回落才解除（去抖）。
- v1 不发邮件 / IM 通知；后续可接现有通知通道。

## 10. 成本与开销

- worker：每 15 s 一次 `os.cpus()` + 读 `/proc/meminfo`（微秒级）；会话级读 `/proc/<pid>/stat`，进程数通常 < 50，单次 < 5 ms；`statfs` 每 60 s。目标：worker CPU 占用增加 < 0.5%，内存增加 < 5 MiB。`systeminformation` 的 `exec` 路径在小机器（如 aliyun 2C）上会明显超过此目标，这是不选它的主因。
- 网络：单帧约 0.5–2 KiB，15 s 一次 → 每 worker < 12 KiB/min。
- hub：内存每 worker ~120 KB；SSE 推送限频（同一 worker 最多 15 s 一次）。
- macOS / Windows：没有 `/proc`，`pidusage` 会退回 `ps` / `wmic`，开销更高——在这些平台把会话级采样降到 30 s。

## 11. 分期

1. M1：contract 帧 + 能力协商；domain 端口与 `assessPressure`；worker `NodeResourceProbe`（机器级）；hub 内存存储；`/api/workers` 附最新值；机器列表显示。
2. M2：会话进程树；会话卡片 / 窗口显示；RBAC 过滤测试。
3. M3：画布 worker 框徽标；阈值与提醒；可选拒绝新会话。
4. M4（可选）：GPU；SQLite 24 h 历史。

每期都要 e2e（含 390px）和 conformance 测试。

## 12. 待决问题（含推荐默认值）

1. **采集实现**：A. `node:os` + `/proc` + `pidtree`/`pidusage`（推荐）；B. `systeminformation` 全家桶；C. 纯 `node:os`（不做会话级）。
2. **传输**：A. 新 `metrics` 帧 + hello 能力协商、不升协议版本（推荐）；B. 改为应用层心跳携带指标；C. 升 `PROTOCOL_VERSION` 到 3 强制所有 worker 升级。
3. **存储**：A. 只内存（最新 + 1 h 环形缓冲）（推荐）；B. 再加 SQLite 1 分钟降采样保留 24 h；C. 只保留最新值、不做走势。
4. **满载策略**：A. 只提示，可按 worker 打开「拒绝新会话」（推荐，默认关）；B. 默认拒绝；C. 只显示数字不判定。
5. **会话级可见性与 GPU**：A. 会话占用跟会话权限走、GPU 默认关闭按 worker 开（推荐）；B. 能看机器就能看所有会话占用；C. 先不做会话级。
