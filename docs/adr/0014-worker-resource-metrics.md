# ADR 0014：worker 上报机器资源占用

- 状态：**proposed**（等 David 拍板 `docs/design/worker-resources.md` §12）
- 日期：2026-10-30

## 背景
hub 对 worker 只有 WebSocket ping/pong 存活检测，看不到机器和会话的资源占用，无法判断「还能不能再开会话」、「哪条会话在吃资源」。

## 决定（拟）
1. worker 新增 `metrics` 帧主动上报（机器级 15 s、磁盘 / GPU 60 s、会话进程树同节拍）；离线判定仍用 ping/pong，两者解耦。
2. 不升 `PROTOCOL_VERSION`，用 hello 的可选 `capabilities` 做协商；老 worker 不报、老 hub 不收，互不断连。
3. domain 定义 `ResourceProbe` 端口与 `assessPressure` 纯策略；采集在 worker 适配器（`node:os` + `/proc` + `pidtree`/`pidusage`），不引入 `systeminformation`。
4. hub v1 只在内存保留最新值 + 1 h 环形缓冲，不落库。
5. 可见性沿用 ADR 0011：机器指标随 `worker.read`，会话指标随会话可见性，阈值配置 `worker.manage`。
6. 满载默认只提示；「拒绝新会话」按 worker 可选开启。

## 后果
- 正面：开会话前能看到机器余量；能定位吃资源的会话；为调度留下数据基础。
- 负面：worker 多一个定时任务和两个小依赖；非 Linux 平台会话级采样较贵（降频）；hub 重启丢走势。

## 备选（已否决，待确认）
- 应用层心跳携带指标：要重写离线判定，风险大。
- 升协议版本：可选功能不值得让老 worker 全部断连。
- `systeminformation`：`exec` 子进程开销在小机器上偏高、依赖大。
