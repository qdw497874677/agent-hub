# Worker 接入：一次性配对码 + 每台机器专属凭据

> 落地 [accounts.md §7.4](accounts.md#74-worker-接入重做取代共享-hub_token)。共享 `HUB_TOKEN` 仍可用（兜底、兼容老机器）。

## 流程

```
浏览器（已登录）                hub                                   新机器
  「＋ 添加机器」 ──POST /api/workers/pairing──▶ 签发 ahw_pair_…（15 分钟、一次性，库里只存 sha256）
  ◀── { code, expiresAt, command } ──
  复制命令 ───────────────────────────────────────────────────────▶ curl -fsSL <hub>/install-worker.sh | HUB_PAIR=… bash
                                  GET /install-worker.sh ◀──────── 引导脚本（hub 地址、提交号已填好）
                                                                     装 Node 26（sha256 校验）→ clone → checkout hub 的提交
                                  ws /worker enroll{code,label,protocol} ◀── apps/worker/src/enroll.ts（第一帧）
                                  作废配对码，签发 ahw_wk_…（32 字节）
                                  只存哈希，绑定新的 workerId
                                  ──enrolled{workerId,credential}，关闭连接──▶ 写 ~/.config/agent-hub/worker.env（0600）
                                                                     systemd unit 起 Worker
                                  ws /worker hello{credential} ◀──── 凭据决定身份，自报的 id 必须一致
  「✓ 工作站 已连上」 ◀── workers 列表轮询
```

## 规则

- **配对码**：`ahw_pair_` + 随机串，15 分钟过期，兑换一次即作废；库里存哈希，明文只在签发响应里出现一次（`Cache-Control: no-store`）。签发、兑换都写审计（`worker.pair`、`worker.enroll`）。
- **兑换走长连接握手**：新机器连 `/worker` 的第一帧是 `enroll`（不是 hello），不要登录；按来源地址限流（10 分钟 10 次，`HUB_ENROLL_RATE_MAX` 可调）；码错、过期、用过都统一关 4401 + 同一句原因，不泄露是哪一种；协议版本不一致关 4426。成功回一帧 `enrolled` 后 hub 关闭这条连接，worker 存好凭据再正常 hello。原来的 `POST /api/workers/enroll` 已拿掉。
- **凭据**绑定一个 workerId。hello 里带凭据 → 用哈希查记录 → 对不上、已吊销、id 不一致都关 4401。
- **有凭据记录的 workerId 不能再走共享 `HUB_TOKEN`**：否则吊销形同虚设。吊销一台老的共享 token 机器时也会写一条占位记录，堵住它。
- **吊销**（Owner 可吊销任何一台，Member 只能吊销自己接入的）：标记凭据、立刻断开（4401 → Worker 不再重连，以退出码 78 退出，unit 里 `RestartPreventExitStatus=78` 让 systemd 也不再拉起），写审计 `worker.revoke`。
- **本机 Worker** 不变：随 hub 启动，走 localSecret。

## 分层

| 层 | 文件 |
| --- | --- |
| domain | `enrollment.ts`（码 / 凭据的生成与哈希）、`ports/enrollment-repository.ts`、`use-cases/enrollment.ts`（issuePairing / enroll / authenticateWorker / revokeWorker） |
| 存储 | `storage-sqlite/src/enrollment.ts` |
| 网关（WS 适配器） | `node-gateway` 的 `authenticate` / `enroll` 钩子、`disconnect(id, 'revoked')`；worker 端 `worker-enroll.ts`（enrollOverLink） |
| 组合 | `apps/server/src/worker-enroll.ts`（限流 → 领域 enrollWorker；不 import 任何传输，CI 检查） |
| HTTP | `apps/server/src/enrollment.ts`（pairing、DELETE、/install-worker.sh） |
| 脚本 | `scripts/bootstrap-worker.sh`（hub 下发的引导）、`scripts/install-worker.sh`（调 `apps/worker/src/enroll.ts`、写配置 + systemd） |
| 界面 | `apps/web/src/add-machine.tsx`（命令、复制、倒计时、等待上线）、Worker 面板与运营后台的「吊销」 |

## 安装脚本细节

- 需要 `git`、`curl`、`bash`；Node 26 没有就装到 `~/.local/node26`（官方 tarball，校验 SHASUMS256）。
- 代码 clone 到 `AGENT_HUB_DIR`（默认 `~/agent-hub`，仓库可用 `AGENT_HUB_REPO` 换），checkout 到 hub 当前的提交（本地分支 `agent-hub-worker`），版本天然一致，之后用后台的「更新」跟进。
- root 装 system unit（`/etc/systemd/system`），普通用户装 user unit 并尝试 `loginctl enable-linger`；没有 systemd 时退化成 `--no-systemd`（只写配置，打印前台启动命令）。
- 参数透传：`curl … | HUB_PAIR=… bash -s -- --no-systemd`。
