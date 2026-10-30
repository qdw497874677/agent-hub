# 在 Worker 上安装运行时（设计稿）

状态：**已定稿并实现**（2026-10-29，David 拍板 D1–D9，见 §12、§13）。对应 ADR [0010](../adr/0010-install-runtimes-on-workers.md)。

## 1. 要解决什么

现在一台 Worker 上的 Pi / OpenCode / Grok 只能由人登录到那台机器上手动安装。装不上或装错的时候，界面上只看得到「未安装」。
目标是：**在 hub 的界面里选一台 Worker，把我们支持的运行时装上去**，过程中能看到日志，装完自动重新探测，并能升级、卸载。

不做的事：

- **不替用户登录**。登录永远由用户在那台机器上自己完成，hub 不经手任何凭据。Grok 尤其不能远程登录。
- 不改那台机器的全局环境：不写 shell 配置，不 `npm -g`，不 `sudo`，不碰用户自己装的那一份。
- 不装我们不支持的运行时，也不支持任意命令（这不是远程 shell）。

沿用资产中心（[asset-hub.md](asset-hub.md)）的方向：**按机器安装、每个运行时一个适配器、版本钉住、看过差异确认后才升级**。

## 2. 官方安装方式调研（2026-10）

| 运行时 | 官方方式 | 前置条件 | 能否装到指定目录 | 本机现状 |
| --- | --- | --- | --- | --- |
| **Pi** | ① `curl -fsSL https://pi.dev/install.sh \| sh`：钉住全部依赖，自带 Node，用 `pi update` 升级；② `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`（不钉传递依赖）。旧包 `@mariozechner/*` 已停在 0.73.1 | Node ≥ 22.19（Worker 自己就有 Node 26），npm 方式不需要生命周期脚本 | npm 可以用 `--prefix <目录>`；安装脚本会装到 `~/.local/share/pi-node` 一类的位置 | 1.4.0，npm 全局安装 |
| **OpenCode** | ① `curl -fsSL https://opencode.ai/install \| bash`（OpenCode 1）；② `npm i -g opencode-ai`（1.x）；③ OpenCode 2 是另一个包 `@opencode/cli`，安装脚本是 `/v2/install`。**1 和 2 都叫 `opencode`，不能并存** | 无（单个二进制）；npm 方式靠平台子包 `@opencode-ai/cli-<平台>` 提供二进制 | 安装脚本认 `OPENCODE_INSTALL_DIR`（早期版本有 bug、会忽略它，所以要先确认版本）；`--no-modify-path` 不改 shell 配置；npm 可以用 `--prefix` | 1.19.4（opencode-ai） |
| **Grok** | `curl -fsSL https://x.ai/cli/install.sh \| bash`，指定版本：`bash -s 1.0.70`；升级用 `grok update --version` | 无（单个二进制），需要 curl | 认 `GROK_BIN_DIR`、`GROK_CHANNEL`（stable/alpha）；二进制下载到 `~/.grok/downloads`，可能改 shell 配置或建软链（安装脚本里有 `config_file` 和 `SYMLINK_CREATED` 分支） | 1.0.70 stable |

结论：

- Pi 和 OpenCode 都用 npm 包，加 `--prefix`（装进我们的目录）和 `--ignore-scripts`，Node 用 Worker 自己那份。可复现，有 npm 的 integrity 校验，不改全局。
- Grok 没有 npm 包，只能用官方脚本，但脚本会写 `~/.grok`（和登录凭据在同一个目录）。方案是：先把脚本下载到本地，再带 `GROK_BIN_DIR=<我们的目录>`、钉死版本号运行；同时**把 HOME 指到一个临时目录**，免得它改 shell 配置。运行后把二进制挪进我们的目录。凭据仍放在真正的 `~/.grok`，由用户自己登录。实现前要先做 spike，确认脚本在这种环境下能正常工作（见待决 D3）。

## 3. 分层（六边形）

```
domain                     ports                          adapters
RuntimeInstall 规则   ──►  HarnessInstaller（Worker 侧，  ──►  pi-installer（npm --prefix）
（版本、状态机、权限）       每个运行时一个）                     opencode-installer（npm --prefix，钉 1.x）
use-cases/runtimes.ts      RuntimeJobRepository（hub）          grok-installer（官方脚本，沙箱 HOME）
                           RuntimeVersionSource（hub：          storage-sqlite（runtime_pins / runtime_jobs）
                             查最新版本）                       npm registry / x.ai 版本源
```

- **`HarnessInstaller` 端口**和现有的 `HarnessReadiness` 放在一起，每个运行时一个适配器，与它的 runtime 共用命令解析：

  ```ts
  interface HarnessInstaller {
    readonly agentId: string;
    /** 不联网、不改东西：能不能装、为什么不能（缺 curl、平台不支持、目录不可写……） */
    precheck(): Promise<{ ok: true } | { ok: false; reason: string }>;
    install(version: string, log: (line: string) => void, signal: AbortSignal): Promise<InstalledRuntime>;
    uninstall(version: string): Promise<void>;
    /** 受管目录里装了哪些版本、当前用哪个 */
    installed(): Promise<readonly InstalledRuntime[]>;
  }
  ```

- **domain** 只放规则：任务的状态机（`queued → running → succeeded | failed | cancelled`）；一台机器上同一个运行时同时只能有一个任务；版本号规则；谁能操作。
- **use case**（hub）：`requestInstall / requestUpgrade / requestUninstall / cancel`，以及处理 Worker 回报的 `onJobReport`。
- Worker 侧的 `worker-link` 只负责转发帧和调用端口，不写任何运行时专属的逻辑。

## 4. Worker 上的目录与命令解析

只用专属目录，和资产目录并列：

```
~/.agent-hub/runtimes/            （WORKER_RUNTIMES_DIR 可改）
  pi/1.4.0/…                       npm --prefix 装进来的
  pi/current -> 1.4.0              原子切换的软链
  opencode/1.19.4/…
  grok/1.0.70/grok
  bin/pi, bin/opencode, bin/grok   指向 current 的薄 shim
  .jobs/<jobId>.log                最近 N 次任务的日志
```

- **安装 = 先装进 `<版本>.staging`，验证 `--version` 通过后改名，再切换 `current`**。失败时删掉 staging，`current` 不动，所以升级失败自动等于回滚。
- **卸载 = 删掉这个运行时的目录**。永远不碰 PATH 里用户自己装的那一份。
- **命令解析**（`command-resolver.ts`）新增一种来源 `managed`。顺序建议为：`X_COMMAND` 显式指定 → **受管目录（只有 hub 装过的才有）** → PATH → 常见位置。理由：hub 装的版本是钉住的，会话应当用它。是否把 `managed` 放在 PATH 前面，列为待决 D2。
- 探测结果带上来源和版本，例如「Pi 1.4.0 · hub 安装」或「Pi 1.3.2 · 系统 PATH」，界面上能看出用的是哪一份。

## 5. 协议（走现有 WS，不开新端口）

```
hub → worker   runtime_job { jobId, agentId, action: 'install'|'upgrade'|'uninstall', version }
hub → worker   runtime_cancel { jobId }
worker → hub   runtime_job_status { jobId, state, message?, version? }
worker → hub   runtime_job_log { jobId, seq, lines[] }      ≤ 每 200ms 一批，单条截断
```

- 照着现有的 `update` / `update_status` 来：Worker 不支持时回 `refused`，已有任务在跑时也回 `refused`。
- 任务结束后 Worker 自己执行 `probe(true)`，把新的 `agents` 推上来，界面上的「未安装」就自动变成「就绪」或「未登录」。
- **日志**：hub 只在内存里保留最近一段，供界面流式显示（经由现有的 SSE `/api/stream` 新增一种 `runtime_job` 帧）；结束后把末尾一段（`logTail`，约 16k）落库。日志先过一遍脱敏（token、`key=` 这类内容）。
- Worker 离线时任务记为 `queued`，上线后不自动执行（避免机器回来后意外装东西），界面提示「机器离线，上线后点重试」。列为待决 D6。

## 6. 版本钉住与升级

- hub 为每台机器、每个运行时记一条**钉住版本**（表 `runtime_pins (worker_id, agent_id, version, installed_at, installed_by)`）。安装时默认用 hub 推荐的版本，也就是 e2e 验证过的版本，写在每个适配器的描述里，例如 `pi@1.4.0`。主人也可以手动选版本。
- 由 `RuntimeVersionSource` 定时查询最新版本：Pi / OpenCode 查 npm registry，Grok 查官方脚本的版本源或 `grok update --check`。查到新版本时只标「可升级」，**不自动升级**。
- 升级要先确认：在弹窗里显示 `1.4.0 → 1.5.2`、官方 changelog 链接，以及我们是否验证过这个版本（是否在推荐表里）。点确认才执行 `upgrade`。
- OpenCode 钉在 1.x（适配器用的是 `opencode acp` / `opencode models`）。2.x 等单独验证之后再开放。

## 7. 权限与审计

- **只有主人可以操作**（`/api/admin/workers/:id/runtimes*`，未登录返回 401，成员返回 403），与资产中心一致。成员只能看到状态。
- 每次安装、升级、卸载、取消都写一条审计，记录操作人、机器、运行时、版本和结果。
- 安装内容是**白名单**：每个适配器写死包名、来源 URL 和参数，hub 只传 `agentId + version`（版本号用正则校验）。不存在「传一段命令过去执行」的通道。

## 8. 失败处理

| 情况 | 处理 |
| --- | --- |
| 预检不过（缺 curl/npm、平台不支持、磁盘不够、目录不可写） | 不开始安装，按钮旁直接写原因 |
| 下载失败或网络超时 | 失败并给出中文原因与日志末尾，可重试；staging 清掉 |
| 校验失败（npm integrity，或 `--version` 跑不起来） | 判为失败，不切换 `current` |
| 超时（默认 10 分钟） | 中止子进程树，判为失败 |
| 用户取消 | 发 abort，判为 `cancelled`，清理 staging |
| 安装途中 Worker 断线或重启 | hub 判为失败（「机器断开」）；Worker 启动时清掉残留的 staging |
| 有会话正在用这个运行时 | 升级和卸载前提示「有 N 个会话在用」。升级只影响新会话（旧进程还在用旧目录，旧版本保留到没有会话在用为止）；卸载要求先结束这些会话 |

## 9. 登录

装完以后，探测结果很可能是「未登录」。界面只给提示，不提供远程登录：

- Grok：「请在这台机器上运行 `grok login --device-auth`，或在 worker.env 里配置 `XAI_API_KEY`」。
- Pi：「在这台机器上运行 `pi`，然后输入 `/login`，或者配置 `~/.pi/agent/models.json`」。
- OpenCode：「运行 `opencode auth login`，或者配置 provider」。

hub 不转发登录流程，不展示 device code，不接收任何密钥。

## 10. 界面草图（机器详情页）

```
┌ 机器：aliyun-1 ───────────────────────────── 在线 ┐
│ 运行时                                              │
│ ┌─────────────────────────────────────────────────┐ │
│ │ Pi        1.4.0 · hub 安装       就绪    [升级 1.5.2] [⋯] │
│ │ OpenCode  —                     未安装：PATH 里找不到 opencode │
│ │                                  [安装 1.19.4]  │ │
│ │ Grok      1.0.70 · 系统 PATH     未登录：在这台机器上运行   │
│ │                                  grok login --device-auth │
│ └─────────────────────────────────────────────────┘ │
│                                                     │
│ ▼ 正在安装 OpenCode 1.19.4 …           [取消]        │
│   npm http fetch GET 200 …/opencode-ai-1.19.4.tgz   │
│   added 2 packages in 3s                            │
│   ✓ opencode --version → 1.19.4                     │
│   ✓ 重新探测：就绪                                   │
└─────────────────────────────────────────────────────┘
```

- 每个运行时一行。不可用时在行内写原因，原因直接用现有探测给的中文；可以安装的才显示「安装」。
- 「⋯」菜单里有：换版本、卸载（只有 hub 安装的才能卸载）、查看上次日志。
- 成员看不到这些按钮。手机（390 宽）上，每个运行时变成一张卡片，日志区域可以折叠。
- 新建会话时如果选了一台没装这个运行时的机器，主人会看到「去安装」的链接。

## 11. 落地顺序（建议）

1. 先改端口和命令解析：加 `managed` 来源，写单测，确保现有行为不变。
2. Pi 安装器（npm `--prefix`）、协议帧、日志流和界面，跑一条 e2e：本机 Worker 从无到有装上 Pi，然后能对话。
3. OpenCode 安装器。
4. Grok 安装器：先做 spike，确认沙箱 HOME 下官方脚本能正常工作。
5. 版本检查、升级确认，然后是卸载。

## 12. 已定决策（2026-10-29）

- **D1 权限**：主人，以及这台机器的登记人（配对它的人，凭据未吊销）都能装 / 卸自己的机器。本机 Worker 只有主人能动。判断在领域层 `canManageRuntimes`。§7 里「只有主人」作废，接口是 `POST /api/workers/:id/runtimes/:agentId`（不在 `/api/admin` 下）。
- **D2 解析优先级**：机器上已经有的（`X_COMMAND` / PATH / 常见安装位置）一律不装、不覆盖，界面显示「机器自带」。
- **D3 Grok**：官方脚本 + 临时 HOME（暂存目录里），装完只拷出二进制、删掉临时家目录；绝不替用户登录。推荐 1.0.70。
- **D4 Pi**：npm `--prefix`，用 Worker 自己那个 Node 配套的 npm。推荐 1.4.0。
- **D5 OpenCode**：只支持 v2（`@opencode/cli`），推荐 2.2.2。先 `--ignore-scripts` 装，再只跑它自己的 postinstall 取本平台二进制。
- **D6 离线**：直接拒绝（「这台机器不在线，连上之后再装」），不排队。
- **D7 卸载**：第一版就做，只卸 hub 装的那份；有会话在用时拒绝。
- **D8 推荐版本**：写死在各安装适配器里，随 hub 发布更新。
- **D9 aliyun**：用它给 server 自带的本机 Worker 装 OpenCode v2，作为第一个线上验证。

## 13. 实现与设计稿的差异

- **不重启 Worker 就生效**：启动时机器上没有的 agent，命令直接指向 hub 管理的 shim `~/.agent-hub/runtimes/bin/<cmd>`（`WORKER_RUNTIMES_DIR` 可改）。装好后立刻重新探测，探测拿到的模型清单补进 agent 清单，界面上「未安装」随即变「可用」。所以不需要 `managed` 这个解析来源，也不会因为重启打断别的会话。
- **进度用轮询，不另开推送**：hub 把每台机器最近一个任务（状态、消息、日志末尾 16k 字符）放在内存里，随 `/api/workers` 返回；界面在有任务进行时每秒刷一次。任务跨 Worker 重连保留；连接断开时把进行中的任务记为失败（同一任务后续进度帧回来仍然认）。
- **状态机简化**：`running → succeeded | failed | refused`，没有 queued / cancelled（离线直接拒、一台一次一个）。超时 10 分钟。
- **老 Worker**：不报 `provision` 字段 → 界面不出现「运行时」一节，接口拒绝（「版本太旧」）。协议版本不变（仍是 2）。
- **环境白名单**：安装命令只拿到 PATH、HOME、语言、代理、npm 源、CA 证书等变量，Worker 的 HUB_TOKEN / 凭据不会传给第三方安装脚本。
- **校验**：用 shim 跑 `--version`，输出里必须含目标版本，否则丢掉暂存目录、不切换。
