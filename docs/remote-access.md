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
