# ADR 0014：worker 上报机器资源占用

- 状态：**accepted**（David 于 2026-10-30 拍板，见 `docs/design/worker-resources.md` §12）
- 日期：2026-10-30

## 背景
hub 对 worker 只有 WebSocket ping/pong 存活检测，看不到机器和会话的资源占用，无法判断「还能不能再开会话」、「哪条会话在吃资源」。

## 决定
1. worker 新增 `metrics` 帧主动上报（机器级 15 s、磁盘 / GPU 60 s、会话进程树同节拍）；离线判定仍用 ping/pong，两者解耦。
2. 不升 `PROTOCOL_VERSION`（仍为 2）：worker 在 hello 里带可选 `capabilities:['metrics']`，hub 在已有的 `welcome` 帧里回可选 `accepts:['metrics']`；worker 只有看到 accepts 才开始发 `metrics` 帧。zod 默认丢弃未知字段，所以老 worker × 新 hub、新 worker × 老 hub 都照常握手，老 hub 永远收不到它不认识的帧。
3. domain 定义 `ResourceProbe` 端口与 `assessPressure` 纯策略；采集在 worker 适配器（`node:os` + `/proc` + `pidtree`/`pidusage`），不引入 `systeminformation`。
4. hub 只在内存保留最新值 + 1 h（最多 300 点）环形缓冲，不落库；样本时间戳用 hub 自己的钟。最新一份随 `/api/workers`（ADR 0010 的 5 s 轮询）下发，历史走 `GET /api/workers/:id/metrics`，不另开 SSE。
5. 可见性沿用 ADR 0011：能看见这台机器（`worker.read`）就能看到机器指标**和**这台机器上所有会话的占用（§12 第 5 问选 B）；「拒绝新会话」开关要 `worker.manage`。
6. 满载默认只提示；「资源紧张时拒绝新会话」按 worker 可选开启（默认关，持久化在 hub 设置 `refuseWhenFull`，改动记审计 `worker.resource_policy`），由 domain `placeSession` 执行。
7. GPU：有 `nvidia-smi` 就自动采（60 s 一次、2 s 超时），第一次失败即判定没有 GPU、之后不再尝试，开销可忽略。

## 后果
- 正面：开会话前能看到机器余量；能定位吃资源的会话；为调度留下数据基础。
- 负面：worker 多一个定时任务和两个小依赖；非 Linux 平台会话级采样较贵（降频）；hub 重启丢走势。

## 备选（已否决）
- 应用层心跳携带指标：要重写离线判定，风险大。
- 升协议版本：可选功能不值得让老 worker 全部断连。
- `systeminformation`：`exec` 子进程开销在小机器上偏高、依赖大。
- SQLite 降采样落库保留 24 h：先不做，需要看长期走势时再加（不影响协议）。
