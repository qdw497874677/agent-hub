#!/usr/bin/env bash
# 把这台机器登记成 agent-hub 的一台 Worker：装依赖、写配置、装 systemd user unit。
#
#   HUB_URL=ws://100.x.y.z:7878/worker HUB_TOKEN=… WORKER_LABEL=工作站 scripts/install-worker.sh
#
# 配置写进 ~/.config/agent-hub/worker.env（权限 600，token 不进 unit 文件、不进日志）。
# Worker 的身份（WORKER_ID）第一次启动时生成并存下来，重装、重启都不会变——会话的落点存的就是它。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/agent-hub"
env_file="$config_dir/worker.env"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

: "${HUB_URL:?需要 HUB_URL，比如 ws://100.x.y.z:7878/worker}"
if [[ -z "${HUB_TOKEN:-}" && "$HUB_URL" != ws://127.0.0.1* && "$HUB_URL" != ws://localhost* ]]; then
  echo "连远程 hub 需要 HUB_TOKEN（和 hub 启动时用的同一个）" >&2
  exit 1
fi

node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  echo "找不到 node（需要 >= 26）" >&2
  exit 1
fi

# WORKER_ROOTS 是安全边界：hub 只能在这些目录里浏览、读写附件、开会话。
if [[ -z "${WORKER_ROOTS:-}" && -t 0 ]]; then
  read -r -p "允许 hub 访问的目录（冒号分隔，回车用 $HOME）：" WORKER_ROOTS || true
fi
WORKER_ROOTS="${WORKER_ROOTS:-$HOME}"
echo "==> WORKER_ROOTS=$WORKER_ROOTS（之后改 $env_file 再 systemctl --user restart agent-hub-worker）"

echo "==> 安装依赖"
cd "$here"
npm install --no-fund --no-audit --omit=dev

echo "==> 写配置 $env_file"
mkdir -p "$config_dir"
umask 077
{
  echo "HUB_URL=$HUB_URL"
  echo "HUB_TOKEN=${HUB_TOKEN:-}"
  echo "WORKER_ORIGIN=remote"
  echo "WORKER_LABEL=${WORKER_LABEL:-$(hostname)}"
  [[ -n "${WORKER_ID:-}" ]] && echo "WORKER_ID=$WORKER_ID"
  echo "WORKER_ROOTS=$WORKER_ROOTS"
  echo "WORKER_STATE_DIR=$config_dir"
} > "$env_file"
chmod 600 "$env_file"

if [[ "${1:-}" == "--no-systemd" ]]; then
  echo "==> 跳过 systemd。前台启动："
  echo "    set -a; . $env_file; set +a; node $here/apps/worker/src/main.ts"
  exit 0
fi

echo "==> 安装 systemd user unit 到 $unit_dir"
mkdir -p "$unit_dir"
cat > "$unit_dir/agent-hub-worker.service" <<UNIT
[Unit]
Description=agent-hub Worker（$HUB_URL）
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$here
EnvironmentFile=$env_file
ExecStart=$node_bin $here/apps/worker/src/main.ts
# Worker 自己会断线重连；进程级崩溃交给 systemd。
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now agent-hub-worker.service
echo "==> 已启动。看日志：journalctl --user -u agent-hub-worker -f"
echo "    想在退出登录后继续跑：loginctl enable-linger $USER"
