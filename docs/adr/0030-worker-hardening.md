# ADR 0030：Worker 加固（参考 t3code 远程连接）

- 状态：accepted（2026-11-02 David 定了 Q1–Q7，全部按推荐，见末尾「定稿」）
- 相关：ADR 0010（Worker 装运行时）、ADR 0014（Worker 资源指标）、ADR 0017（权限模型）、ADR 0021（运行时包）、ADR 0025（工作区文件）
- 参考：t3code `61c3794c`（2026-11-02，MIT）
  - `packages/client-runtime/src/connection/supervisor.ts`、`docs/internals/connection-runtime.md`（重连、探测、「传输健康 ≠ 数据新鲜」）
  - `apps/server/src/serviceLauncher.ts`、`docs/internals/server-updates.md`（staging → 试运行 → 提交 → 回滚，更新前快照 SQLite，磁盘预检）
  - `docs/internals/environment-auth.md`、`apps/server/src/auth/RpcAuthorization.ts`（scope 授权，只能收窄不能放宽）
  - `packages/ssh/src/tunnel.ts:440-512`（远端安装：下载、sha256 校验、加锁、staging、`--version` 预检）

## 背景：现状（已核实，master `d23ff84`）

调研结论是「t3code 有、我们没有或较弱」。但下面几项其实**已经有一部分**，本 ADR 只补缺口，不重做：

| 主题 | 已有 | 缺口 |
|---|---|---|
| 心跳 | hub 每 10s ping 一次，一轮没收到 pong 就 terminate（`server-gateway.ts:118-149,505-520`）；Worker 30s 没收到 ping 就 terminate 并重连（`worker-link.ts:58,316-325,381`）；抖动退避 0.5–15s，4401 或被管理员断开时不再重连（`worker-link.ts:400-418`）；断线期间的帧放进 outbox 补发（`worker-link.ts:303-313`） | ① 间隔和超时是硬编码默认值，两端没有协商；② 只靠 ws 控制帧，hub 事件循环卡住或 Worker 业务线程卡住时测不出来（应用层没有回声）；③ UI 只有在线/离线和「最近 xx」（`apps/web/src/admin/workers.tsx:128`），分不清「连接断了」和「连着但没同步完」；④ outbox 溢出丢帧只在日志里有记录 |
| 更新 | 先从 hub 取 git bundle（sha256），取不到再 git fetch；`merge --ff-only` + `npm ci`，失败就 `reset --hard` 回原提交（`updater.ts:100-150`）；启动守卫：写 `update-pending` 标记，新版连上 hub 并稳定一段时间后删除，否则启动 2 次后回滚（`scripts/worker-boot-guard.sh`、`boot-marker.ts`）；tarball 安装用 `<目录>.prev` 互换 | ① 在**正在运行的工作区里原地** `merge` + `npm ci`，更新途中 Worker 还在用旧 node_modules；② 「健康」由 Worker 自己判断，hub 不参与提交，看不到「试运行中」；③ 回滚要重新 `npm ci`，慢且依赖网络 |
| hub 部署 | 部署脚本只在运维机上（box `/workspace/remote/deploy.sh`）：`VACUUM INTO` 快照 + `integrity_check` | 不在仓库里，没有磁盘预检，没有保留策略，换人或换机器就丢了 |
| 凭据 | 一次性配对码只存 hash，15 分钟过期（`domain/enrollment.ts:10`、`storage-sqlite/enrollment.ts`）；专属凭据只存 hash，可吊销（`revoked_at`）；hello 时记录了 `remoteAddress`（`server-gateway.ts:282`），但没持久化 | ① 凭据没有能力上限，hub 能发给 Worker 的方法全都放行；② 没有轮换；③ UI 不显示来源 IP 和最后一次连接的时间点（`lastSeenAt` 是心跳时间，不是「这次连上」的时间） |
| 安装 | 一行命令 `curl …/install-worker.sh \| HUB_PAIR=… bash`；Node 包、libatomic、代码 bundle 都校验 sha256（`bootstrap-worker.sh:45-81`）；`run-worker` 有 flock（`install-worker.sh:154-155`） | ① 引导脚本本身没有校验（`curl \| bash`）；② **安装过程**没加锁，同时跑两次会互相覆盖；③ 没有集中的预检（OS/架构、磁盘、HUB_URL 可达、时钟偏差、systemd --user 可用），失败要到一半才暴露 |

## 决定

整体遵循六边形架构：规则和状态机放在 `packages/domain`（纯函数和端口），传输、存储、脚本是适配器（`node-gateway`、`storage-sqlite`、`apps/*`、`scripts/*`）。domain 不 import ws、fs、child_process（`check-domain-purity.mjs` 守着）。

### D1 连接健康：双向心跳 + 应用层回声 + 状态分层

**领域**：新增 `packages/domain/src/link-health.ts`，是纯状态机：

```
LinkState = connecting | syncing | live | degraded | disconnected | rejected
事件：opened / welcomed / inventoryApplied / pong(rtt) / echo(rtt) / missed / closed(code) / rejected
```

- `live` 要求 welcome 已收到，**且**首轮 inventory/metrics 已应用（t3code「socket 打开不代表能用」，`connection-runtime.md`「Transport health and data freshness are separate」）。
- 连续丢 1 次控制帧心跳记为 `degraded`，丢 2 次判定半开连接，terminate 后转入 `disconnected`。
- 应用层回声：每 30s 发一次 `{type:'rpc', method:'link.echo'}`，走 `worker-methods.ts` 的 RPC 表，不新造帧。超过 10s 没回则记 `degraded`，用来发现「ws 线程活着、业务循环卡死」。
- 参数由 hub 在 welcome 中下发 `heartbeat:{intervalMs, missLimit, echoMs}`，Worker 的 watchdog 取 `intervalMs × (missLimit+1)`。旧 hub 不下发时，沿用现在的 10s / 30s。

**端口**：`ports/worker-control.ts` 增加 `linkState(workerId): LinkSnapshot`（state、since、rttMs、lastConnectedAt、remoteAddress、outboxDropped）。

**适配器**：
- `server-gateway.ts`：心跳维持现状，只是改为把事件喂给状态机。
- `worker-link.ts`：沿用已有的退避和 outbox。退避上限从 15s 提到 60s（参照 t3code 的 5 分钟，但我们的 Worker 是常驻服务，60s 更合适），连接稳定 60s 后才重置 attempt；outbox 溢出时在下次 hello 里报告 `dropped`（已有计数，补上透传）。

**UI**：机器列表和会话页顶部用统一的 `LinkBadge`：
- 绿「在线」：live。
- 蓝「同步中」：syncing，已连上，正在收清单和指标。
- 黄「连接不稳」：degraded，显示 RTT。
- 灰「已断开 · 3 分钟前 · 自动重连中」：disconnected。
- 红「已拒绝」：rejected，凭据被吊销或不匹配，不会再重连，并给出「重新配对」按钮。
- 会话页：Worker 处于 disconnected 时，输入框上方显示「这台机器暂时连不上，消息会在重连后发出」；处于 syncing 时不显示这条提示。不会把「同步中」误报成「断线」。

### D2 更新：staging → 预检 → 切换 → 试运行 → hub 握手提交 → 自动回滚

**目录布局**（git 安装和 tarball 安装统一）：

```
~/.local/share/agent-hub/worker/
  releases/<40位提交>/       不可变，一次装好
  current -> releases/<sha>  systemd ExecStart 指向 current
  previous -> releases/<sha> 上一个已提交版本
  state/update.json         {id, previous, target, phase, boots, startedAt}
```

**流程**（领域状态机 `packages/domain/src/worker-update.ts`，适配器只负责执行步骤）：

1. `staging`：在 `releases/.staging-<随机>` 中取代码（hub bundle/tarball，sha256 校验 → 退回 git），执行 `npm ci --omit=dev`。**不动 current**，也不影响正在运行的 Worker。
2. `preflight`：用 staging 里的 node 执行 `node apps/worker/src/main.ts --selfcheck`，检查 import 全通、协议版本 ≥ hub 要求的 `minWorkerProtocol`、`WORKER_ROOTS` 可读。失败就删除 staging，报 `failed`，**什么都没改**。
3. `publish`：`rename` 成 `releases/<sha>`，通过原子替换 symlink 更新 `previous` 和 `current`，用写临时文件 + fsync + rename 的方式写 `update.json{phase:'trial'}`。
4. `trial`：退出，由 systemd 重启。新版本在 hello 中带上 `update:{id, phase:'trial'}`。
5. `commit`：hub 收到 trial hello 后开始观察，满足以下条件就下发 `update_commit{id}`：首轮 inventory 已应用、`link.echo` 正常、**稳定 60s 且没有重连**。Worker 收到后把 `update.json` 改为 `committed`，并清除旧的 boot-marker。
6. `rollback`，任一条件触发：
   - 启动守卫发现 `phase=trial` 且 boots > 2，执行 `ln -sfn previous current`。**不用重新 npm ci**，previous 的依赖是完整的。
   - hub 在 5 分钟内没等到健康的 trial，下发 `update_abort{id}`，Worker 自行切回。
   - 回滚后写 `update-rolledback`（复用现有 note 格式），由旧版本连上后报 `rolled_back`。
7. 只保留 current、previous 和最多 1 个更早的版本，其余在 commit 后清理。

`worker-boot-guard.sh` 仍用 bash 写，只改成「切 symlink」，依旧不依赖仓库里的 JS。旧布局（原地 git 工作区）的 Worker 第一次更新时迁移：把现有工作区当作 previous 原样保留，新版本装进 releases。

**hub 端**：`WorkerUpdatePolicy` 放在 domain，决定何时 commit 或 abort。admin UI 的更新进度条增加「试运行中（剩 42s）」一档。

**hub 部署前快照 + 磁盘预检**（把运维机上的脚本收进仓库）：
- 新增 `apps/server/src/cli/backup.ts`，在 `main.ts` 中接为子命令 `node apps/server/src/main.ts backup [--keep N]`。
  - 预检：`statfs(data/)` 的可用空间 ≥ `max(2×db+wal 大小, 512MB)`，不够就报错退出（exit 3），不做快照。
  - 执行 `VACUUM INTO backups/hub-<时间>-pre-<sha>.db`，然后跑 `PRAGMA integrity_check`，结果不是 `ok` 就删掉快照并 exit 4。
  - 保留最近 N 份（默认 10），并在 stdout 打印 JSON `{path, bytes, integrity}`。
- 新增 `scripts/deploy-hub.sh`（仓库内，不含任何主机或密码）：`backup` → `git fetch/merge --ff-only` → `npm ci` → 重启 → `curl /api/health`。health 失败时回到原提交并重启，**但不自动恢复 DB**（迁移是只增的，恢复 DB 需人工确认，见 Q4）。
- 领域层只有纯函数 `backupPlan(dbBytes, freeBytes)`，返回 `{ok, need}`。

### D3 Worker 凭据：能力上限、连接信息、轮换、吊销

**能力**：domain 新增 `worker-capability.ts`：

```
WorkerCapability =
  'sessions'      起 agent 会话（start_session/prompt/…）
  'files.read'    fs.* 读、files.list/read/find/diff/watch
  'files.write'   fs.make_directory、files.restore/checkpoint
  'git'           ws.*（clone/worktree/commit/push/save_wip/remove）
  'git.remote'    ws.push、ws.gh（会对外写）
  'runtimes'      runtime_job（装/卸 CLI）
  'update'        update（自更新）
预设：full（全部）| readonly（files.read）| no-remote（去掉 git.remote）| no-install（去掉 runtimes、update）
```

- 方法和能力的对应关系写在 `contract/worker-methods.ts` 的每个 `method()` 上，新增必填参数 `capability`，漏写会编译失败（参照 t3code `McpToolAccess`「每个工具必须声明」）。
- **双端强制**：
  - hub 在 `server-gateway` 发 RPC 或帧之前，用 `canInvoke(credential.capabilities, method)` 检查，不通过直接返回 `forbidden`，不发出去。
  - Worker 在 `hello` 返回的 welcome 中拿到自己的能力集，收到越权请求同样返回 `forbidden`，防止 hub 侧有 bug。
- **只能收窄不能放宽**：配对码创建时带上能力集；Worker 用码换凭据时只能取交集。改能力需要重新签发（D3 轮换）或由管理员收窄，**收窄即时生效**（hub 重新下发 welcome 能力）；放宽要重新配对。
- **诚实边界**（同 t3code 的说明）：`sessions` 本身就是在那台机器上跑任意代码的 agent，所以 `readonly` 预设**不含** `sessions`。「能跑 agent 但不能动 git」只是在限制 hub 自己的工具，不是沙箱。UI 上明说这一点。

**连接信息**：`worker_credentials` 增加 `last_connected_at`、`last_address`、`last_user_agent`（Worker 版本、提交）、`rotated_at`，hello 时写入。`lastSeenAt` 保持心跳语义不变。UI 显示「上次连上 11-02 21:03 PST · 来自 47.x.x.12 · 版本 67d0045」。地址取 socket 的 `remoteAddress`；只有 `HUB_TRUST_PROXY=1` 时才读 `X-Forwarded-For` 的最后一跳。

**轮换**：
- 管理员点「轮换凭据」后，hub 生成新凭据，通过当前已认证的连接下发 `credential_rotate{newCredential}`。
- Worker 把它写入 env 文件（tmp + fsync + rename），然后用新凭据重连。
- hub 先保留旧 hash 5 分钟（`grace_until`）：新凭据连上就删旧的；5 分钟内没换成功就作废新的，留旧的，并在 UI 报「轮换失败」。
- 凭据明文只在这条帧里出现一次，不写日志（wire 日志对 `credential_*` 帧做脱敏）。
- Worker 离线时不能轮换（按钮置灰），这种情况只能吊销后重新配对。

**吊销**：现有功能保留。吊销后 hub 立刻 `close(4401)`，Worker 停止重连，UI 显示「已拒绝」。

**端口**：`ports/enrollment-repository.ts` 增加 `recordConnection`、`setCapabilities`、`beginRotation`、`completeRotation`；存储迁移只增列。

### D4 安装脚本：sha256 校验、加锁、预检（保留复制命令，hub 不持有 SSH 凭据）

- **引导脚本校验**：「添加机器」给出的命令改为：
  ```
  curl -fsSL http://hub/install/bootstrap.sh -o /tmp/ahb.sh && echo "<sha256>  /tmp/ahb.sh" | sha256sum -c - && HUB_PAIR=… bash /tmp/ahb.sh
  ```
  sha256 由 hub 根据自己发布的脚本计算，嵌入命令中（`apps/server/src/install-artifacts.ts`）。保留旧的 `| bash` 形式作为「简短版」折叠项。
  - 注意：命令和脚本来自同一个 hub，这一步防的是传输损坏和中间人篡改；在 HTTP 上它防不了中间人（因为命令也是从同一个 hub 拿的），**真正的防护靠 HTTPS**，见 Q5。
- **加锁**：`bootstrap-worker.sh` 和 `install-worker.sh` 在开头 `flock -n ~/.config/agent-hub/install.lock`；没有 flock 时退回 `mkdir` 锁加 pid 文件，并检测残留锁。第二个实例提示「已有安装在进行（pid …）」后退出（exit 0）。
- **预检**（一次全做完再动手，全部失败项一起列出）：
  - OS 是 Linux 或 macOS、架构是 x64 或 arm64；
  - `$HOME` 可写，可用空间 ≥ 1.5GB；
  - `curl`/`tar` 存在；
  - `HUB_URL` 可达（`/api/health`，5s）且协议版本兼容；
  - 本机和 hub 的时钟偏差 < 5 分钟（配对码有 TTL）；
  - `systemctl --user` 可用（不可用时提示会改用备用启动脚本）；
  - 端口和已有安装检测：已有安装时提示是更新还是重装。
- 预检规则（阈值、文案）放在 `packages/domain/src/install-precheck.ts` 作为数据，由 hub 渲染进脚本。脚本只执行检查、比较结果，便于测试。

## 分阶段上线

| 阶段 | 内容 | 依赖 | 风险与回退 |
|---|---|---|---|
| P1 | D1 状态机 + LinkBadge + welcome 下发心跳参数 + link.echo；D2 中的 hub `backup` 子命令和 `deploy-hub.sh` | 无 | 纯增量；旧 Worker 不认识 echo 时回 `unknown method`，hub 视为「不支持」，退回只看控制帧 |
| P2 | D4 安装：校验命令、加锁、预检 | 无 | 只影响新装机器；旧命令仍可用 |
| P3 | D3 连接信息列 + UI；能力字段默认 `full`，加双端检查 | P1（welcome 扩展） | 默认 full 等于行为不变；先上 hub，再上 Worker |
| P4 | D3 预设能力（配对时可选）+ 轮换 | P3 | 轮换带 5 分钟宽限，失败会保留旧凭据 |
| P5 | D2 Worker releases 布局 + staging/试运行/握手提交 | P1 | 风险最大：先在测试 Worker（`/home/box/agent-hub-e2e`）跑满一周，再给其他 Worker 开；`HUB_WORKER_UPDATE_MODE=legacy` 可退回原地更新 |

每个阶段单独一个 PR，配 e2e（断网模拟：`iptables` 不可用时用 hub 侧丢弃 pong 的测试钩子）。

## 开放问题（附推荐）

- **Q1 心跳参数**：A 10s×2（20s 判死，现状）/ B 15s×3（45s）/ C 由 hub 按 RTT 自适应。**推荐 A 并允许 welcome 覆盖**。我们的 Worker 大多在云上，网络稳定；20s 判死对用户感知更好。
- **Q2 试运行稳定窗口**：A 30s / B 60s / C 等到首个会话成功跑完一轮。**推荐 B**。C 太依赖使用情况，空闲的 Worker 会一直处于 trial。
- **Q3 readonly 预设含不含 sessions**：A 不含（真正只读）/ B 含（能跑 agent，但 hub 工具不能写）。**推荐 A**，并提供 `no-remote` 预设覆盖「能跑 agent，但不 push、不开 PR」的需求。B 会给人虚假的安全感。
- **Q4 hub 部署失败时是否自动恢复 DB**：A 只回退代码 / B 也自动恢复快照。**推荐 A**。迁移只增，旧代码能读新库；自动恢复会丢掉部署后这段时间的新数据，应由人工判断。
- **Q5 hub HTTPS**：sha256 校验命令只有在 HTTPS 下才能防中间人。A 本 ADR 不管 / B 文档推荐反代加 HTTPS，并在 UI 对 HTTP 安装给出提示。**推荐 B**（只加提示，不强制，也不碰现有 live 部署）。
- **Q6 轮换要不要定期自动做**：A 只手动 / B 每 90 天自动。**推荐 A**，等 P4 稳定后再考虑 B。
- **Q7 能力在哪里存**：A 存在凭据行上 / B 单独一张 worker_policies 表（将来可按团队）。**推荐 A**。和 ADR 0017 的 cluster-admin 模型一致，够用。

## 不做

- 不做 t3code 那种客户端直连 + Cloudflare 隧道 relay：我们以 hub 为中心，Worker 只需出站。
- hub 不持有 SSH 凭据，也不提供「通过 SSH 一键添加机器」，保持复制命令的方式。
- 不做 DPoP 式密钥绑定（成本高，留作后续：凭据文件被复制的风险，靠吊销加轮换缓解）。

## 原型图

`/workspace/shots/worker-hardening/`（box 上，不进仓库）：
- `machines-1280.png` / `machines-390.png`：机器列表，包含五种 LinkBadge、连接信息、能力预设，以及试运行中的更新。
- `add-machine-1280.png` / `add-machine-390.png`：添加机器，包含能力预设、带校验的命令和预检项说明。
- `worker-detail-1280.png` / `worker-detail-390.png`：单台机器详情，包含凭据（轮换、吊销）和更新时间线。

## 定稿（2026-11-02，David）

Q1–Q7 全部按推荐：
- Q1：10s×2（20s 判死），welcome 可覆盖。
- Q2：试运行稳定窗口 60s。
- Q3：readonly 不含 sessions；另设 no-remote。
- Q4：hub 部署失败只回退代码，不自动恢复 DB。
- Q5：只提示 HTTPS，不强制。
- Q6：轮换只做手动。
- Q7：能力存在凭据行上。

按 P1→P5 顺序实现，每阶段一个 PR。P5 先只在测试 Worker 上启用（`HUB_WORKER_UPDATE_MODE` 可退回 legacy），作为试运行。

### P5 实现说明（试运行中）

- 开关：worker.env 里 `HUB_WORKER_UPDATE_MODE=releases`（默认 legacy），根目录 `WORKER_RELEASES_DIR`（默认 `~/.local/share/agent-hub/worker`）。本机 Worker、非 git 检出一律仍按 legacy。
- 启动：`scripts/worker-start.sh` 在 releases 模式下跑 `current` 指向的版本；守卫 `worker-boot-guard.sh` 仍从原工作区运行（bash，不依赖新代码）。
- 迁移：第一次更新时原工作区原样成为 `previous`，新版本装进 `releases/<sha>`（从正在跑的检出克隆，缺的提交先取 hub bundle 再 git fetch origin），`npm ci --omit=dev` + `apps/worker/src/selfcheck.ts` 预检通过才换 `current`。
- 试运行：hello 带 `update:{id, phase:'trial'}`；hub 用 `decideTrial`（domain/worker-update.ts）判断，满足即发 `update_commit`，5 分钟没通过发 `update_abort`。新版本起不来由守卫数到 boots > 2 切回 `previous`。两种回退都写 `update-rolledback`，旧版连上后补报 `rolled_back`。
- 提交后清理：只留 current、previous 和 1 个更早的 release。
