#!/usr/bin/env bash
# 部署阿里云 hub：备份 → ff-only → npm ci → build → restart → health，失败自动回退代码。
# 实际执行的是服务器上的 scripts/deploy-hub.sh；这里只负责带上本机 .env.deploy.local 的目标参数。
#
# 用法：scripts/deploy-aliyun.sh                      # 服务器自己 git fetch（需要能访问 GitHub）
#       scripts/deploy-aliyun.sh --bundle <old-sha>   # 本地打 bundle 上传（阿里云连不上 GitHub，DEP-1）
# 退出码：同 scripts/deploy-hub.sh（0/2/3/4/1）；本地打包或上传失败为 1。
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE=${ALIYUN_ENV_FILE:-"$ROOT/.env.deploy.local"}

usage() {
  cat <<'EOF'
用法：scripts/deploy-aliyun.sh [--bundle [old-sha]]

  （无参数）            服务器上 git fetch 后快进到 ALIYUN_REF（默认 origin/master）
  --bundle              自动问服务器当前 HEAD，本地打「它..HEAD」的 bundle，上传后快进
  --bundle <old-sha>    同上，但用你指定的起点（服务器当前 HEAD 的提交号）

<old-sha> 省略时由 scripts/aliyun-ssh.sh 'git -C <app> rev-parse HEAD' 现查。
服务器连不上 GitHub 时走这条路径（阿里云默认如此）。
EOF
}

BUNDLE_FROM=
WANT_BUNDLE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bundle)
      WANT_BUNDLE=1
      if [ $# -ge 2 ] && [ "${2#-}" = "$2" ]; then BUNDLE_FROM=$2; shift 2; else shift; fi ;;
    --help|-h) usage; exit 0 ;;
    *) echo "不认识的参数：$1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "缺少 $ENV_FILE（见 AGENTS.md §2）" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${ALIYUN_APP_DIR:?ALIYUN_APP_DIR 未配置}"
: "${ALIYUN_DATA_DIR:?ALIYUN_DATA_DIR 未配置}"
: "${ALIYUN_SERVICE:?ALIYUN_SERVICE 未配置}"
ALIYUN_NODE=${ALIYUN_NODE:-node}
ALIYUN_PORT=${ALIYUN_PORT:-17900}
ALIYUN_REF=${ALIYUN_REF:-origin/master}

# --bundle 不带起点时现查服务器 HEAD：省得每次手工 rev-parse，也避免猜错起点打出空 bundle。
if [ "$WANT_BUNDLE" = 1 ] && [ -z "$BUNDLE_FROM" ]; then
  echo "[deploy-aliyun] 现查 $ALIYUN_SSH_USER@$ALIYUN_HOST:$ALIYUN_APP_DIR 的当前提交…"
  BUNDLE_FROM=$(
    "$ROOT/scripts/aliyun-ssh.sh" "git -C '$ALIYUN_APP_DIR' rev-parse HEAD" 2>/dev/null \
      | tr -d '\r' | grep -E '^[0-9a-f]{40}$' | tail -1
  ) || true
  [ -n "$BUNDLE_FROM" ] || {
    echo "[deploy-aliyun] 查不到服务器当前提交；请显式传 --bundle <old-sha>（或确认 SSH 能连上）" >&2
    exit 1
  }
  echo "[deploy-aliyun] 服务器在 ${BUNDLE_FROM:0:12}"
fi

if [ -n "$BUNDLE_FROM" ]; then
  # 本地打包 → sha256 → 上传；远端 decode 只认 bundle，不再碰 GitHub。
  git -C "$ROOT" rev-parse --verify -q "$BUNDLE_FROM^{commit}" >/dev/null \
    || { echo "[deploy-aliyun] 不认识的 <old-sha>：$BUNDLE_FROM" >&2; usage >&2; exit 1; }
  NEW=$(git -C "$ROOT" rev-parse HEAD)
  SHA=${NEW:0:12}
  mkdir -p /tmp/opencode
  BUNDLE=/tmp/opencode/hub-$SHA.bundle
  echo "[deploy-aliyun] 打包 $BUNDLE_FROM..$NEW → $BUNDLE"
  # 末端必须写成 HEAD（git ≥2.55 拒绝用裸 sha 做 bundle 的 rev-list 顶端，报 "Refusing to create empty bundle"）；
  # bundle 失败（old-sha 不是祖先等）会让 set -e 直接退出 1
  git -C "$ROOT" bundle create "$BUNDLE" "$BUNDLE_FROM..HEAD"
  sha256sum "$BUNDLE"

  REMOTE_BUNDLE=/tmp/hub-$SHA.bundle
  echo "[deploy-aliyun] 上传到 $ALIYUN_SSH_USER@$ALIYUN_HOST:$REMOTE_BUNDLE"
  "$ROOT/scripts/aliyun-ssh.sh" "cat > '$REMOTE_BUNDLE'" < "$BUNDLE"

  REF_ARG="--bundle '$REMOTE_BUNDLE'"
  echo "[deploy-aliyun] 目标：$ALIYUN_SSH_USER@$ALIYUN_HOST:$ALIYUN_APP_DIR（$ALIYUN_SERVICE，:$ALIYUN_PORT，bundle ${SHA}）"
else
  REF_ARG="--ref '$ALIYUN_REF'"
  echo "[deploy-aliyun] 目标：$ALIYUN_SSH_USER@$ALIYUN_HOST:$ALIYUN_APP_DIR（$ALIYUN_SERVICE，:$ALIYUN_PORT，$ALIYUN_REF）"
fi

REMOTE=$(
  cat <<EOF
set -euo pipefail
cd '$ALIYUN_APP_DIR'
exec bash scripts/deploy-hub.sh \
  --app '$ALIYUN_APP_DIR' \
  --data-dir '$ALIYUN_DATA_DIR' \
  --service '$ALIYUN_SERVICE' \
  --node '$ALIYUN_NODE' \
  --health 'http://127.0.0.1:$ALIYUN_PORT/api/health' \
  $REF_ARG
EOF
)

exec "$ROOT/scripts/aliyun-ssh.sh" "$REMOTE"
