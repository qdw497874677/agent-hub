#!/usr/bin/env bash
# 手动更新这台 Worker（和机器列表里点「更新」走同样的安全步骤）：
#
#   scripts/update-worker.sh            # 快进到当前分支跟踪的上游（git pull --ff-only）
#   scripts/update-worker.sh <提交号>    # 快进到指定提交（比如 hub 机器列表里显示的那个）
#
# 工作区有未提交改动就拒绝；装依赖失败就回滚到原提交；成功后重启 agent-hub-worker 服务。
# 协议版本不兼容（Worker 日志里提示「协议版本不兼容」）时只能用它更新。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"
target="${1:-}"
if [[ -n "$target" && ! "$target" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "提交号只能是 7–40 位十六进制" >&2
  exit 2
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "工作区有未提交的改动，拒绝更新（先提交或 git stash）" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

previous="$(git rev-parse HEAD)"
echo "==> 当前 ${previous:0:7}，拉取代码"
git fetch --quiet origin
if [[ -n "$target" ]]; then
  git merge --ff-only "$target"
else
  git merge --ff-only '@{upstream}'
fi
now="$(git rev-parse HEAD)"
if [[ "$now" == "$previous" ]]; then
  echo "==> 已是最新（${now:0:7}），无需更新"
  exit 0
fi

echo "==> 安装依赖（${previous:0:7} → ${now:0:7}）"
if ! npm ci --omit=dev --no-audit --no-fund; then
  echo "npm ci 失败，回滚到 ${previous:0:7}" >&2
  git reset --hard "$previous"
  npm ci --omit=dev --no-audit --no-fund || echo "回滚后重装依赖也失败了，请手动处理" >&2
  exit 1
fi

if systemctl --user cat agent-hub-worker.service >/dev/null 2>&1; then
  echo "==> 重启 agent-hub-worker"
  systemctl --user restart agent-hub-worker
else
  echo "==> 没装 systemd 服务：请手动重启 Worker（node apps/worker/src/main.ts）"
fi
echo "==> 已更新到 ${now:0:7}"
