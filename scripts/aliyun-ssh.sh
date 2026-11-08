#!/usr/bin/env bash
# 通过密码 SSH 到阿里云环境执行一条命令。
# 用法：scripts/aliyun-ssh.sh '<远程命令>'
# 凭据来自 .env.deploy.local（不进 git）。密码只写进一个临时 askpass 文件，退出即删。
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

: "${ALIYUN_HOST:?ALIYUN_HOST 未配置}"
: "${ALIYUN_SSH_USER:?ALIYUN_SSH_USER 未配置}"
: "${ALIYUN_SSH_PASSWORD:?ALIYUN_SSH_PASSWORD 未配置}"
ALIYUN_SSH_PORT=${ALIYUN_SSH_PORT:-22}

if [ "$#" -eq 0 ]; then
  echo "用法：$0 '<远程命令>'" >&2
  exit 64
fi

ASKPASS=$(mktemp "${TMPDIR:-/tmp}/aliyun-askpass.XXXXXX")
cleanup() { rm -f "$ASKPASS"; }
trap cleanup EXIT INT TERM

{
  echo '#!/bin/sh'
  printf 'printf "%%s\\n" %q\n' "$ALIYUN_SSH_PASSWORD"
} > "$ASKPASS"
chmod 700 "$ASKPASS"

SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force setsid -w ssh \
  -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=10 \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -p "$ALIYUN_SSH_PORT" \
  "$ALIYUN_SSH_USER@$ALIYUN_HOST" "$@"
