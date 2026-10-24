#!/usr/bin/env bash
# 一次安装：装依赖、建数据目录、装 systemd user unit。
# 不做 Docker —— 容器会切断 PTY 与宿主机的 agent 凭据（mvp-plan §5）。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data_dir="${HUB_DATA_DIR:-$HOME/.local/share/agent-hub}"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

echo "==> 安装依赖"
cd "$here"
npm install --no-fund --no-audit

echo "==> 构建前端"
npm run --workspace @agent-hub/web build

echo "==> 数据目录 $data_dir"
mkdir -p "$data_dir"

if [[ "${1:-}" == "--no-systemd" ]]; then
  echo "==> 跳过 systemd"
  echo "启动：npm run up   （控制台 http://127.0.0.1:7878）"
  exit 0
fi

echo "==> 安装 systemd user unit 到 $unit_dir"
mkdir -p "$unit_dir"
cat > "$unit_dir/agent-hub.service" <<UNIT
[Unit]
Description=agent-hub（本地 agent 控制台）
After=network.target

[Service]
Type=simple
WorkingDirectory=$here
ExecStart=$(command -v node) $here/apps/server/src/main.ts
Environment=HUB_DATA_DIR=$data_dir
Environment=HUB_PORT=7878
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now agent-hub.service

echo "==> 好了"
systemctl --user --no-pager status agent-hub.service | head -5
echo
echo "控制台：http://127.0.0.1:7878"
echo "日志：journalctl --user -u agent-hub -f"
