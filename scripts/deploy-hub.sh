#!/usr/bin/env bash
# hub 部署（ADR 0030 D2）：快照 → 快进 → 装依赖 → 构建 → 重启 → 健康检查；失败只回退代码，绝不自动恢复数据库（Q4）。
#
# 用法：scripts/deploy-hub.sh --app DIR --data-dir DIR --service NAME [--node BIN] [--health URL] [--ref origin/master] [--bundle FILE] [--keep N]
# 退出码：0 成功；2 新版本起不来、已回退到旧代码；3 磁盘不够没备份；4 快照坏了；1 其它。
set -euo pipefail

APP=; DATA=; SERVICE=; NODE=node; HEALTH=http://127.0.0.1:${HUB_PORT:-17900}/api/health; REF=origin/master; BUNDLE=; KEEP=10
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP=$2; shift 2 ;;
    --data-dir) DATA=$2; shift 2 ;;
    --service) SERVICE=$2; shift 2 ;;
    --node) NODE=$2; shift 2 ;;
    --health) HEALTH=$2; shift 2 ;;
    --ref) REF=$2; shift 2 ;;
    --bundle) BUNDLE=$2; shift 2 ;;
    --keep) KEEP=$2; shift 2 ;;
    *) echo "不认识的参数：$1" >&2; exit 1 ;;
  esac
done
[ -n "$APP" ] && [ -n "$DATA" ] && [ -n "$SERVICE" ] || { echo "要 --app --data-dir --service" >&2; exit 1; }
export PATH="$(dirname "$NODE"):$PATH"
cd "$APP"
say() { echo "[deploy] $*"; }

PREV=$(git rev-parse HEAD)
say "当前 $PREV"

# 1. 快照：用旧代码的 backup 子命令；旧代码还没有它（第一次）就用内联的 VACUUM INTO
if grep -q "argv\[2\] === 'backup'" apps/server/src/main.ts; then
  set +e; HUB_DATA_DIR="$DATA" "$NODE" apps/server/src/main.ts backup --keep "$KEEP"; code=$?; set -e
  [ $code -eq 0 ] || { say "快照失败（退出码 $code），不部署"; exit $code; }
else
  OUT="$DATA/../backups/hub-$(date +%Y%m%d-%H%M%S)-pre-${PREV:0:7}.db"; mkdir -p "$(dirname "$OUT")"
  "$NODE" -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.argv[1]).exec(\"VACUUM INTO '\"+process.argv[2]+\"'\");const r=new DatabaseSync(process.argv[2]).prepare('PRAGMA integrity_check').get().integrity_check;console.log(JSON.stringify({ok:r==='ok',path:process.argv[2],integrity:r}));process.exit(r==='ok'?0:4)" "$DATA/hub.db" "$OUT"
fi

# 2. 代码：给了 --bundle 就走本地代码包（阿里云解析不了 github.com，DEP-1），否则照旧从远端快进
if [ -n "$BUNDLE" ]; then
  [ -f "$BUNDLE" ] || { say "bundle 不存在：$BUNDLE"; exit 1; }
  git bundle verify -q "$BUNDLE" >/dev/null || { say "bundle 校验失败：$BUNDLE"; exit 1; }
  SHA=$(git bundle list-heads "$BUNDLE" | awk 'NR==1 {print $1}')
  [ -n "$SHA" ] || { say "bundle 里没有 ref：$BUNDLE"; exit 1; }
  say "bundle $BUNDLE → deploy-$SHA"
  git fetch -q "$BUNDLE" "+HEAD:refs/heads/deploy-$SHA"
  git merge -q --ff-only "deploy-$SHA"
else
  git fetch -q
  git merge -q --ff-only "$REF"
fi
NEXT=$(git rev-parse HEAD)
say "目标 $NEXT"

build() { npm ci --silent >/dev/null 2>&1 && npm run build >/dev/null 2>&1; }
healthy() {
  for _ in $(seq 1 30); do
    sleep 2
    systemctl is-active -q "$SERVICE" && curl -fsS -m 3 "$HEALTH" >/dev/null 2>&1 && return 0
  done
  return 1
}

if build && systemctl restart "$SERVICE" && healthy; then
  say "完成：$(git log --oneline -1)"
  exit 0
fi

# 3. 失败：只回退代码（数据库可能已被新代码迁移过——要恢复就人工从上面的快照来）
say "新版本起不来，回退到 $PREV（数据库不动）"
git reset -q --hard "$PREV"
build || true
systemctl restart "$SERVICE" || true
healthy && say "已回退并恢复服务" || say "回退后仍不健康，需要人工处理"
exit 2
