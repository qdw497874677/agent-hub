#!/usr/bin/env bash
# 把这台机器登记成 agent-hub 的一台 Worker：装依赖、写配置、装 systemd unit。
#
# 推荐：在控制台「机器 → 添加机器」拿一行命令（curl 引导脚本 | HUB_PAIR=… bash），它最后会调到这里。
# 手动：
#   HUB_HTTP=http://100.x.y.z:7878 HUB_PAIR=ahw_pair_… scripts/install-worker.sh   # 一次性接入码
#   HUB_URL=ws://100.x.y.z:7878/worker HUB_TOKEN=… scripts/install-worker.sh        # 老办法：共享令牌
#
# 配置写进 ~/.config/agent-hub/worker.env（权限 600，凭据不进 unit 文件、不进日志）。
#
# 同一台机器装第二台 Worker：WORKER_INSTANCE=<名字>。配置目录 ~/.config/agent-hub-<名字>、
# 资产目录 ~/.agent-hub/assets-<名字>、服务 agent-hub-worker-<名字>，默认名字 <hostname>-<名字>；
# 代码目录由引导脚本放到 ~/agent-hub-<名字>（手动装就自己另 clone 一份，在那份里跑本脚本）。
# 用接入码时 WORKER_ID 由 hub 分配并和专属凭据绑定；共享令牌时第一次启动生成并存下来。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "${WORKER_INSTANCE:-}" && ! "$WORKER_INSTANCE" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]; then
  echo "WORKER_INSTANCE 只能用小写字母、数字和 -（不超过 32 个字符）" >&2
  exit 1
fi
suffix="${WORKER_INSTANCE:+-$WORKER_INSTANCE}"
service="agent-hub-worker$suffix"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/agent-hub$suffix"
if [[ -z "${WORKER_ASSETS_DIR:-}" && -n "$suffix" ]]; then WORKER_ASSETS_DIR="$HOME/.agent-hub/assets$suffix"; fi
env_file="$config_dir/worker.env"

# root 装成系统服务（新开的云主机常见），普通用户装 user unit。
if [[ $EUID -eq 0 ]]; then
  unit_dir=/etc/systemd/system
  sysctl=(systemctl)
  wanted_by=multi-user.target
else
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  sysctl=(systemctl --user)
  wanted_by=default.target
fi

if [[ -z "${HUB_URL:-}" && -n "${HUB_HTTP:-}" ]]; then
  HUB_URL="${HUB_HTTP/#http/ws}/worker"
fi
: "${HUB_URL:?需要 HUB_URL（ws://100.x.y.z:7878/worker）或 HUB_HTTP（http://100.x.y.z:7878）}"
HUB_HTTP="${HUB_HTTP:-$(printf '%s' "${HUB_URL%/worker}" | sed 's#^ws#http#')}"
if [[ -z "${HUB_PAIR:-}" && -z "${HUB_TOKEN:-}" && "$HUB_URL" != ws://127.0.0.1* && "$HUB_URL" != ws://localhost* ]]; then
  echo "连远程 hub 需要接入码 HUB_PAIR（控制台「添加机器」）或共享令牌 HUB_TOKEN" >&2
  exit 1
fi

node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  echo "找不到 node（需要 >= 26）" >&2
  exit 1
fi
if ! node_v="$("$node_bin" -v 2>&1)"; then
  echo "node（$node_bin）跑不起来，先修好再重装：" >&2
  echo "    $node_v" >&2
  [[ "$node_v" == *libatomic* ]] && echo "    缺 libatomic：sudo yum install -y libatomic（RHEL 系）或 sudo apt install -y libatomic1（Debian 系）" >&2
  exit 1
fi
# bootstrap 自带的 libatomic（见 bootstrap-worker.sh）：node 壳已经会带上，这里再写进 worker.env 兜底
node_lib="$(cd "$(dirname "$node_bin")/.." && pwd)/lib"
[[ -f "$node_lib/libatomic.so.1" ]] || node_lib=""

# WORKER_ROOTS 是安全边界：hub 只能在这些目录里浏览、读写附件、开会话。
if [[ -z "${WORKER_ROOTS:-}" && -t 0 ]]; then
  read -r -p "允许 hub 访问的目录（冒号分隔，回车用 $HOME）：" WORKER_ROOTS || true
fi
WORKER_ROOTS="${WORKER_ROOTS:-$HOME}"
echo "==> WORKER_ROOTS=$WORKER_ROOTS（之后改 $env_file 再 ${sysctl[*]} restart $service）"

echo "==> 安装依赖"
cd "$here"
npm install --no-fund --no-audit --omit=dev

label="${WORKER_LABEL:-$(hostname 2>/dev/null || uname -n)$suffix}"
credential=""
if [[ -n "${HUB_PAIR:-}" ]]; then
  echo "==> 用接入码经长连接 $HUB_URL 换专属凭据"
  # 走 /worker 长连接的 enroll 握手；码和凭据都只经环境变量 / 管道，不出现在命令行和日志里。
  enrolled="$(HUB_URL="$HUB_URL" HUB_PAIR="$HUB_PAIR" WORKER_LABEL="$label" "$node_bin" "$here/apps/worker/src/enroll.ts")"
  WORKER_ID="$(sed -n 1p <<<"$enrolled")"
  credential="$(sed -n 2p <<<"$enrolled")"
  unset enrolled HUB_PAIR
  echo "==> 已接入，这台机器是 $WORKER_ID"
fi

# systemd 不读登录 shell 的配置：npm / nvm / 安装脚本装的 harness（pi、opencode、grok）在 Worker 里常常「找不到」。
# 装的时候用登录 shell 问一次它们在哪，把目录写进 worker.env 的 PATH。
# 合并顺序：harness 目录 → node 目录 → 旧 worker.env 里的 PATH（重装不丢手加的）→ 当前 PATH → 系统默认；去重。
# Worker 运行时还有一层兜底（resolveCommand），不在运行时开登录 shell。
harness_dirs() {
  local sh
  for sh in "${SHELL:-}" bash; do
    [[ -n "$sh" ]] && command -v "$sh" >/dev/null || continue
    timeout 20 "$sh" -lc 'for c in pi opencode grok; do command -v "$c"; done' </dev/null 2>/dev/null || true
  done | while read -r found; do
    [[ "$found" == /* ]] && dirname "$found"
  done
}
old_path=""
if [[ -f "$env_file" ]]; then old_path="$(sed -n 's/^PATH=//p' "$env_file" | tail -1)"; fi
worker_path="$({
  harness_dirs
  dirname "$node_bin"
  tr ':' '\n' <<<"$old_path"
  tr ':' '\n' <<<"$PATH"
  tr ':' '\n' <<<"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
} | awk 'NF && !seen[$0]++' | paste -sd: -)"
found_harnesses="$(harness_dirs | sort -u | paste -sd' ' -)"
echo "==> harness 所在目录：${found_harnesses:-（登录 shell 里没找到 pi / opencode / grok）}"

echo "==> 写配置 $env_file"
mkdir -p "$config_dir"
umask 077
{
  echo "HUB_URL=$HUB_URL"
  echo "HUB_TOKEN=${HUB_TOKEN:-}"
  [[ -n "$credential" ]] && echo "HUB_WORKER_CREDENTIAL=$credential"
  echo "WORKER_ORIGIN=remote"
  echo "WORKER_LABEL=$label"
  if [[ -n "${WORKER_ID:-}" ]]; then echo "WORKER_ID=$WORKER_ID"; fi
  echo "WORKER_ROOTS=$WORKER_ROOTS"
  echo "WORKER_STATE_DIR=$config_dir"
  echo "PATH=$worker_path"
  if [[ -n "$node_lib" ]]; then echo "LD_LIBRARY_PATH=$node_lib"; fi
  if [[ -n "${WORKER_ASSETS_DIR:-}" ]]; then echo "WORKER_ASSETS_DIR=$WORKER_ASSETS_DIR"; fi
} > "$env_file"
chmod 600 "$env_file"

# 没有可用的 systemd（容器、没 user 实例 / DBus 的机器）就用一个自带的守护循环：nohup 起，crontab @reboot 开机拉起。
systemd_ok() {
  command -v systemctl >/dev/null || return 1
  if [[ $EUID -eq 0 ]]; then systemctl show-environment >/dev/null 2>&1; else systemctl --user show-environment >/dev/null 2>&1; fi
}
launcher="$config_dir/run-worker.sh"
start_without_systemd() {
  cat > "$launcher" <<RUN
#!/usr/bin/env bash
# agent-hub Worker 守护循环（没有 systemd 时用）：崩了 3 秒后重启；退出码 78（hub 拒绝这台机器）就停。
exec 9>"$config_dir/run-worker.lock"
if command -v flock >/dev/null; then flock -n 9 || { echo "已经在跑了"; exit 0; }; fi
cd "$here"
while true; do
  bash "$here/scripts/worker-boot-guard.sh" || true
  (set -a; . "$env_file"; set +a; exec "$node_bin" "$here/apps/worker/src/main.ts")
  code=\$?
  [[ \$code -eq 78 ]] && { echo "hub 拒绝了这台机器（退出码 78），不再重启"; exit 78; }
  sleep 3
done
RUN
  chmod 700 "$launcher"
  pkill -f "$launcher" 2>/dev/null || true
  sleep 1
  nohup setsid bash "$launcher" >>"$config_dir/worker.log" 2>&1 </dev/null &
  echo "==> 已在后台启动（不经 systemd）。看日志：tail -f $config_dir/worker.log"
  echo "    停止：pkill -f $launcher"
  if command -v crontab >/dev/null; then
    { crontab -l 2>/dev/null | grep -vF "$launcher" || true; echo "@reboot bash $launcher >>$config_dir/worker.log 2>&1"; } | crontab - 2>/dev/null \
      && echo "    已加 crontab @reboot：重启机器后自动拉起" \
      || echo "    提示：crontab 写不进去，重启机器后要手动执行 nohup bash $launcher &"
  else
    echo "    提示：没有 crontab，重启机器后要手动执行 nohup bash $launcher >>$config_dir/worker.log 2>&1 &"
  fi
}

if [[ "${1:-}" == "--no-systemd" ]]; then
  echo "==> 跳过 systemd。前台启动："
  echo "    set -a; . $env_file; set +a; node $here/apps/worker/src/main.ts"
  echo "    （或后台常驻：nohup bash $launcher &，重装时去掉 --no-systemd 会自动写好它）"
  exit 0
fi
if ! systemd_ok; then
  echo "==> 这台机器用不了 systemd$([[ $EUID -ne 0 ]] && echo " --user")（没有 user 实例或 DBus），改用后台守护循环"
  start_without_systemd
  exit 0
fi

echo "==> 安装 systemd unit 到 $unit_dir"
mkdir -p "$unit_dir"
cat > "$unit_dir/$service.service" <<UNIT
[Unit]
Description=agent-hub Worker（$HUB_URL）
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$here
EnvironmentFile=$env_file
# 自更新后新版本连续起不来就回滚到原提交（见脚本注释）；前面的 - 表示守卫失败也照常启动。
ExecStartPre=-/usr/bin/env bash $here/scripts/worker-boot-guard.sh
ExecStart=$node_bin $here/apps/worker/src/main.ts
# Worker 自己会断线重连；进程级崩溃交给 systemd。
Restart=always
RestartSec=3
# 78：hub 拒绝了这台机器（凭据无效或已吊销），重启也没用
RestartPreventExitStatus=78

[Install]
WantedBy=$wanted_by
UNIT

if [[ $EUID -ne 0 ]]; then
  # 不登录也要跑：user unit 需要 linger（没权限就提示，不中断安装）。
  user="${USER:-$(id -un)}"
  if [[ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null)" != yes ]]; then
    if loginctl enable-linger "$user" 2>/dev/null && [[ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null)" == yes ]]; then
      echo "==> 已开启 linger：退出登录后 Worker 继续跑"
    else
      echo "    注意：没能开启 linger（需要管理员）。退出登录后这台 Worker 会停；请管理员执行 sudo loginctl enable-linger $user"
    fi
  fi
fi
"${sysctl[@]}" daemon-reload
"${sysctl[@]}" enable "$service.service"
"${sysctl[@]}" restart "$service.service"
echo "==> 已启动。看日志：journalctl ${sysctl[1]:-} -u $service -f"
