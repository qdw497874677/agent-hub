#!/usr/bin/env bash
# 启动 Worker：`worker-start.sh <node>`。环境（worker.env）由调用方加载好（systemd EnvironmentFile / run-worker.sh）。
#
# HUB_WORKER_UPDATE_MODE=releases（ADR 0030 D2，先只在测试 Worker 上开）：跑 $WORKER_RELEASES_DIR/current 指向的版本；
# 还没有 current（第一次更新前）或模式是 legacy（默认）就跑本仓库里的代码（原地 git 工作区）。
set -uo pipefail
node_bin="${1:-node}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
code="$here"
if [[ "${HUB_WORKER_UPDATE_MODE:-legacy}" == "releases" ]]; then
  root="${WORKER_RELEASES_DIR:-$HOME/.local/share/agent-hub/worker}"
  if [[ -f "$root/current/apps/worker/src/main.ts" ]]; then code="$(readlink -f "$root/current")"; fi
fi
cd "$code" || exit 1
exec "$node_bin" "$code/apps/worker/src/main.ts"
