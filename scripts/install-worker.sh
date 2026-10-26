#!/usr/bin/env bash
# 把这台机器登记成 agent-hub 的一台 Worker：装依赖、写配置、装 systemd unit。
#
# 推荐：在控制台「机器 → 添加机器」拿一行命令（curl 引导脚本 | HUB_PAIR=… bash），它最后会调到这里。
# 手动：
#   HUB_HTTP=http://100.x.y.z:7878 HUB_PAIR=ahw_pair_… scripts/install-worker.sh   # 一次性接入码
#   HUB_URL=ws://100.x.y.z:7878/worker HUB_TOKEN=… scripts/install-worker.sh        # 老办法：共享令牌
#
# 配置写进 ~/.config/agent-hub/worker.env（权限 600，凭据不进 unit 文件、不进日志）。
# 用接入码时 WORKER_ID 由 hub 分配并和专属凭据绑定；共享令牌时第一次启动生成并存下来。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/agent-hub"
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

# WORKER_ROOTS 是安全边界：hub 只能在这些目录里浏览、读写附件、开会话。
if [[ -z "${WORKER_ROOTS:-}" && -t 0 ]]; then
  read -r -p "允许 hub 访问的目录（冒号分隔，回车用 $HOME）：" WORKER_ROOTS || true
fi
WORKER_ROOTS="${WORKER_ROOTS:-$HOME}"
echo "==> WORKER_ROOTS=$WORKER_ROOTS（之后改 $env_file 再 systemctl --user restart agent-hub-worker）"

echo "==> 安装依赖"
cd "$here"
npm install --no-fund --no-audit --omit=dev

label="${WORKER_LABEL:-$(hostname)}"
credential=""
if [[ -n "${HUB_PAIR:-}" ]]; then
  echo "==> 用接入码向 $HUB_HTTP 换专属凭据"
  # 走 node 的 fetch：不依赖 jq；码和凭据都只经环境变量 / 管道，不出现在命令行和日志里。
  enrolled="$(HUB_HTTP="$HUB_HTTP" HUB_PAIR="$HUB_PAIR" WORKER_LABEL="$label" "$node_bin" --input-type=module -e '
    const res = await fetch(`${process.env.HUB_HTTP}/api/workers/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: process.env.HUB_PAIR, label: process.env.WORKER_LABEL })
    }).catch((e) => { console.error(`连不上 hub：${e.message}`); process.exit(1); });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { console.error(body?.error?.message ?? `hub 返回 ${res.status}`); process.exit(1); }
    console.log(`${body.workerId}\n${body.credential}`);
  ')"
  WORKER_ID="$(sed -n 1p <<<"$enrolled")"
  credential="$(sed -n 2p <<<"$enrolled")"
  unset enrolled HUB_PAIR
  echo "==> 已接入，这台机器是 $WORKER_ID"
fi

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
} > "$env_file"
chmod 600 "$env_file"

if [[ "${1:-}" == "--no-systemd" ]] || ! command -v systemctl >/dev/null; then
  echo "==> 跳过 systemd。前台启动："
  echo "    set -a; . $env_file; set +a; node $here/apps/worker/src/main.ts"
  exit 0
fi

echo "==> 安装 systemd unit 到 $unit_dir"
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
WantedBy=$wanted_by
UNIT

if [[ $EUID -ne 0 ]]; then
  # 不登录也要跑：user unit 需要 linger（没权限就提示，不中断安装）。
  loginctl enable-linger "$USER" 2>/dev/null || echo "    提示：退出登录后要继续跑，请执行 sudo loginctl enable-linger $USER"
fi
"${sysctl[@]}" daemon-reload
"${sysctl[@]}" enable agent-hub-worker.service
"${sysctl[@]}" restart agent-hub-worker.service
echo "==> 已启动。看日志：journalctl ${sysctl[1]:-} -u agent-hub-worker -f"
