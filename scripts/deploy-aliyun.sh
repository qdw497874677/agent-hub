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
用法：scripts/deploy-aliyun.sh [--bundle <old-sha>]

  （无参数）          服务器上 git fetch 后快进到 ALIYUN_REF（默认 origin/master）
  --bundle <old-sha>  本地打 <old-sha>..HEAD 的 bundle，上传后让远端 deploy-hub.sh --bundle 快进

<old-sha> 是服务器当前 HEAD（scripts/aliyun-ssh.sh 'git -C <app> rev-parse HEAD'）。
EOF
}

BUNDLE_FROM=
while [ $# -gt 0 ]; do
  case "$1" in
    --bundle)
      [ $# -ge 2 ] || { usage >&2; exit 1; }
      BUNDLE_FROM=$2; shift 2 ;;
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
