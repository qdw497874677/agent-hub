#!/usr/bin/env bash
# 部署阿里云 hub：备份 → ff-only → npm ci → build → restart → health，失败自动回退代码。
# 实际执行的是服务器上的 scripts/deploy-hub.sh；这里只负责带上本机 .env.deploy.local 的目标参数。
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE=${ALIYUN_ENV_FILE:-"$ROOT/.env.deploy.local"}

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
ALIYUN_PORT=${ALIYUN_PORT:-7878}
ALIYUN_REF=${ALIYUN_REF:-origin/master}

echo "[deploy-aliyun] 目标：$ALIYUN_SSH_USER@$ALIYUN_HOST:$ALIYUN_APP_DIR（$ALIYUN_SERVICE，:$ALIYUN_PORT，$ALIYUN_REF）"

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
  --ref '$ALIYUN_REF'
EOF
)

exec "$ROOT/scripts/aliyun-ssh.sh" "$REMOTE"
