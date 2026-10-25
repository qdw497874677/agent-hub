# 从手机 / 另一台电脑访问 agent-hub

agent-hub 默认只监听 `127.0.0.1:7878`。想在手机上看会话、接着说话，需要让手机能连到这台机器，**同时不能把 agent 集群裸露到公网**。

## 推荐：Tailscale + HUB_TOKEN

1. 手机和跑 hub 的机器装上 Tailscale，登录同一个 tailnet。用 `tailscale ip -4` 查到本机的 tailnet IP（`100.x.y.z`）。
2. 带上 token，绑定到 tailnet IP 启动：

   ```bash
   export HUB_TOKEN="$(openssl rand -hex 24)"   # 记下来
   HUB_HOST=100.x.y.z npm run up
   ```

   绑定到非回环地址却没设 `HUB_TOKEN` 时，server 会拒绝启动，这是故意的。
3. 手机浏览器打开一次 `http://100.x.y.z:7878/?token=<HUB_TOKEN>`。token 会存进 localStorage，并立刻从地址栏抹掉，之后直接打开 `http://100.x.y.z:7878/` 就行。
4. 用浏览器的「添加到主屏幕」装成 PWA（有 manifest，以 standalone 方式全屏打开）。

## 想要 HTTPS（部分浏览器只给 https 的页面装 PWA）

```bash
tailscale serve --bg 7878          # https://<机器名>.<tailnet>.ts.net → 127.0.0.1:7878
```

这样 hub 继续监听回环地址，由 Tailscale 负责证书和只对 tailnet 可见。即便如此，也仍然建议设 `HUB_TOKEN`：tailnet 里的其他设备不一定都是你自己的。

## 不要这样做

- 不要在路由器上做端口转发，也不要用 ngrok 这类公网隧道把 7878 暴露出去。拿到这个端口就能让你的 agent 在你的机器上执行命令。
- 不要用裸 TCP 转发（比如 `socat`，或一段把 `100.x:7878` 接到 `127.0.0.1:7878` 的 node 脚本）绕过 token 检查：hub 会以为请求来自回环地址。只有在 tailnet ACL 保证只有你自己的设备能访问时，才可以临时这么用。

## 手机上的使用方式

- 窄屏默认进入**列表**视图；点一行就进入专注对话。画布仍然可以用（双指缩放），任务卡和会话卡上的「＋ 会话」「对话」按钮在触屏上常驻显示，不需要双击。
- 地址栏就是导航状态（`#/p/<项目>/<视图>/<会话>`）：刷新、返回手势、把链接发给自己的另一台设备，都会回到同一个画面。
- 切到后台再回来时，SSE 会自动重连，并用 `events?after=<lastSeq>` 补上断线期间的输出。顶栏出现「● 重连中」表示正在重连。

## 多台机器

任何一台能连到 hub 的机器都可以登记成 **Worker**，把它上面的 agent、凭据和目录接进同一个控制台。

### 加一台

hub 那边按上面的方式绑在 tailnet IP 上并设好 `HUB_TOKEN`。然后在新机器上：

```bash
git clone <agent-hub 仓库> && cd agent-hub
HUB_URL=ws://100.x.y.z:7878/worker \
HUB_TOKEN=<和 hub 同一个> \
WORKER_LABEL=工作站 \
WORKER_ROOTS=$HOME/code \
scripts/install-worker.sh            # --no-systemd：只写配置，前台自己跑
```

- 配置写进 `~/.config/agent-hub/worker.env`（权限 600）；systemd user unit 名为 `agent-hub-worker`，用 `EnvironmentFile` 读它，token 不会出现在 unit 文件和进程参数里。
- **身份稳定**：第一次启动生成 `WORKER_ID` 存到 `~/.config/agent-hub/worker-id.remote`，重启、重装都不变。会话记住的就是这个 id。想手动指定就设 `WORKER_ID`。
- 退出登录后还要跑：`loginctl enable-linger $USER`。

### 它怎么工作

| 场景 | 行为 |
| --- | --- |
| 新建项目 | 选「目录在哪台机器上」；目录选择器浏览那台的文件系统，路径存在性也由那台确认 |
| 开会话 | 项目绑了 Worker → 落在那台；否则可以手动选，或「自动」（本机优先，其次任一装了这个 agent 的在线 Worker） |
| 续聊 / 分叉 | 回到会话原来那台。那台离线时明确报「不可用」，不会悄悄换一台（另一台上没有它的上下文） |
| 断线 | Worker 指数退避重连（0.5s 起，最多 15s），重新 hello，并报上手上还活着的会话，hub 把它们接回；断线期间的输出攒在本地补发 |
| 半开连接 | hub 每 10s ping 一次，一个周期没有 pong 就判离线（原因「心跳超时」）；Worker 30s 收不到 ping 也会主动断开重连 |
| token 不对 | 连接被拒（4401），Worker 不再重试，不刷屏 |

### 已知限制

- 远程项目的**附件**和 `@` 文件补全目前还读 hub 本机的文件系统；在远程项目里请直接让 agent 读路径。
- Worker 之间不迁移会话：某台机器永久下线后，它名下的会话只能看历史，不能续聊。
