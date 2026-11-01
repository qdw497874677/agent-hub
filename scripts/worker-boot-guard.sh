#!/usr/bin/env bash
# Worker 启动前的守卫（systemd 的 ExecStartPre 调它）：自更新后新代码起不来就自动回滚。
#
# 自更新成功、退出重启前，Worker 会写一个标记 `$WORKER_STATE_DIR/update-pending`：
#   <原提交> <目标提交> <已启动次数>
# 新版本连上 hub 并稳定一会儿后，Worker 自己删掉它（= 健康）。
# 每次启动这里先把次数 +1；超过 WORKER_BOOT_ATTEMPTS（默认 2）还没被删，
# 说明新版本一直起不来：回到原提交、重装依赖、删标记，再交给 systemd 正常启动。
# 解压安装的则把 <目录>.prev 换回来（见 runTarballUpdate）。
#
# 故意用 bash 写、不依赖仓库里的任何 JS：新代码坏到 import 就崩，它也照样能跑。
# 任何情况下都以 0 退出——守卫自己出问题不该拦住 Worker 启动。
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
state="${WORKER_STATE_DIR:-$HOME/.config/agent-hub}"
marker="$state/update-pending"
limit="${WORKER_BOOT_ATTEMPTS:-2}"
npm_bin="${AGENT_HUB_NPM:-npm}"
note="$state/update-rolledback"
# 回退后留一份记录，Worker 用旧版连上 hub 时补报「已回退」（见 readRollbackNote）
log_tail() { # 备用启动脚本写 worker.log；systemd 的在 journal 里
  local f="${WORKER_LOG_FILE:-$state/worker.log}"
  if [[ -f "$f" ]]; then tail -n 30 "$f" 2>/dev/null
  elif command -v journalctl >/dev/null; then
    local u="${WORKER_SERVICE:-agent-hub-worker}"
    { timeout 5 journalctl --user -u "$u" -n 30 -o cat 2>/dev/null || timeout 5 journalctl -u "$u" -n 30 -o cat 2>/dev/null; } | grep -v '^-- No entries'
  fi | cut -c1-200
}
write_note() { # write_note <结果说明>
  { printf '%s %s\n' "$target" "$previous"
    echo "新版本 ${target:0:7} 连续 ${limit} 次启动都没能连上 hub 并稳定运行，启动守卫$1。"
    local t; t="$(log_tail)"
    if [[ -n "$t" ]]; then echo "--- 最近的 Worker 日志 ---"; echo "$t"; fi
  } > "$note.tmp" 2>/dev/null && mv -f "$note.tmp" "$note"
}

[[ -f "$marker" ]] || exit 0
read -r previous target boots < "$marker" || true
if [[ ! "$previous" =~ ^[0-9a-f]{40}$ || ! "$target" =~ ^[0-9a-f]{40}$ || ! "${boots:-}" =~ ^[0-9]+$ ]]; then
  echo "[boot-guard] 更新标记格式不对，忽略并删除" >&2
  rm -f "$marker"
  exit 0
fi

boots=$((boots + 1))
if (( boots <= limit )); then
  printf '%s %s %s\n' "$previous" "$target" "$boots" > "$marker"
  echo "[boot-guard] 新版本 ${target:0:7} 第 ${boots} 次启动（超过 ${limit} 次没报健康就回滚）"
  exit 0
fi

echo "[boot-guard] 新版本 ${target:0:7} 连续 ${limit} 次没能健康启动，回滚到 ${previous:0:7}" >&2
# 解压安装（没有 .git）：更新时旧版整目录留在 <目录>.prev，换回来即可，不用联网
if [[ ! -d "$here/.git" ]]; then
  prev_dir="$here.prev"
  if [[ -f "$prev_dir/.agent-hub-commit" && "$(tr -d '[:space:]' < "$prev_dir/.agent-hub-commit")" == "$previous" ]]; then
    rm -rf "$here.failed"
    if mv "$here" "$here.failed" && mv "$prev_dir" "$here"; then
      echo "[boot-guard] 已换回 ${previous:0:7}（坏掉的新版留在 $here.failed）" >&2
      write_note "已把旧版目录换回来（坏掉的新版留在 $here.failed）"
    else
      [[ -d "$here" ]] || mv "$here.failed" "$here"
      echo "[boot-guard] 换回旧版失败，请手动处理（$prev_dir）" >&2
    fi
  else
    echo "[boot-guard] 找不到旧版目录 $prev_dir，没法回滚：请重跑「添加机器」的安装命令" >&2
  fi
  rm -f "$marker"
  exit 0
fi
cd "$here" || exit 0
if git reset --hard "$previous" && "$npm_bin" ci --omit=dev --no-audit --no-fund; then
  echo "[boot-guard] 已回滚到 ${previous:0:7}" >&2
  write_note "已 git 回滚到 ${previous:0:7} 并重装依赖"
else
  echo "[boot-guard] 回滚失败，请手动处理（scripts/update-worker.sh ${previous:0:7}）" >&2
fi
rm -f "$marker"
exit 0
