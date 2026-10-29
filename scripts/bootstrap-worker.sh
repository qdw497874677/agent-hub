#!/usr/bin/env bash
# agent-hub Worker 引导脚本：hub 在 GET /install-worker.sh 上发这个文件，并填好下面两个占位。
#
#   curl -fsSL http://hub:7878/install-worker.sh | HUB_PAIR=ahw_pair_… bash
#   （不装 systemd、前台跑：… | HUB_PAIR=… bash -s -- --no-systemd）
#
# 在一台全新的 Linux 上：没有 Node 26 就装一份到 ~/.local/node26，把仓库拉到 ~/agent-hub
# 并切到和 hub 一样的提交，然后交给 scripts/install-worker.sh（换凭据、写配置、装 systemd）。
#
# 同一台机器再装一台 Worker：加 WORKER_INSTANCE=<名字>（小写字母、数字、-），
# 代码、配置、资产目录和 systemd 服务都带上这个后缀，和已有的那台互不干扰（见 install-worker.sh）。
set -euo pipefail

HUB_HTTP="${HUB_HTTP:-__HUB_HTTP__}"
HUB_COMMIT="${HUB_COMMIT:-__HUB_COMMIT__}"
REPO="${AGENT_HUB_REPO:-https://github.com/qdw497874677/agent-hub.git}"
if [[ -n "${WORKER_INSTANCE:-}" && ! "$WORKER_INSTANCE" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]; then
  echo "WORKER_INSTANCE 只能用小写字母、数字和 -（不超过 32 个字符）" >&2
  exit 1
fi
DIR="${AGENT_HUB_DIR:-$HOME/agent-hub${WORKER_INSTANCE:+-$WORKER_INSTANCE}}"
NODE_MAJOR=26

: "${HUB_PAIR:?需要接入码：在控制台「机器 → 添加机器」复制完整命令}"

need() { command -v "$1" >/dev/null || { echo "缺少 $1，请先安装（比如 apt install -y $1）" >&2; exit 1; }; }
need git
need curl

node_ok() { command -v node >/dev/null && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge $NODE_MAJOR ]]; }
if ! node_ok && [[ -x "$HOME/.local/node$NODE_MAJOR/bin/node" ]]; then
  export PATH="$HOME/.local/node$NODE_MAJOR/bin:$PATH"
fi
if ! node_ok; then
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "不认识的 CPU 架构 $(uname -m)：请自己装 Node $NODE_MAJOR" >&2; exit 1 ;;
  esac
  # tar + xz 只有装 Node 时才用得上（nodejs.org 的包是 .tar.xz）
  need tar
  need xz
  echo "==> 安装 Node $NODE_MAJOR 到 ~/.local/node$NODE_MAJOR"
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  file="$(curl -fsSL "$base/SHASUMS256.txt" | awk '{print $2}' | grep -E "^node-v[0-9.]+-linux-$arch\.tar\.xz$" | head -1)"
  [[ -n "$file" ]] || { echo "nodejs.org 上找不到 Node $NODE_MAJOR 的 linux-$arch 包" >&2; exit 1; }
  tmp="$(mktemp -d)"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && curl -fsSL "$base/SHASUMS256.txt" | grep " $file\$" | sha256sum -c - >/dev/null) || { echo "Node 包校验失败" >&2; exit 1; }
  mkdir -p "$HOME/.local/node$NODE_MAJOR"
  tar -xJf "$tmp/$file" -C "$HOME/.local/node$NODE_MAJOR" --strip-components=1
  rm -rf "$tmp"
  export PATH="$HOME/.local/node$NODE_MAJOR/bin:$PATH"
fi
echo "==> Node $(node -v)"

if [[ -d "$DIR/.git" ]]; then
  echo "==> 更新 $DIR"
  git -C "$DIR" fetch --quiet origin
else
  echo "==> 克隆 $REPO 到 $DIR"
  git clone --quiet "$REPO" "$DIR"
fi
if [[ -n "$HUB_COMMIT" ]]; then
  # 和 hub 同一个提交：协议版本天然一致；之后由 hub 的「更新」按钮推着走。
  git -C "$DIR" checkout --quiet -B agent-hub-worker "$HUB_COMMIT" \
    || { echo "仓库里没有 hub 的提交 $HUB_COMMIT（hub 跑的是没推上去的代码？）；先用默认分支" >&2; git -C "$DIR" checkout --quiet origin/HEAD; }
fi

export HUB_HTTP HUB_PAIR
[[ -n "${WORKER_INSTANCE:-}" ]] && export WORKER_INSTANCE
exec "$DIR/scripts/install-worker.sh" "$@"
