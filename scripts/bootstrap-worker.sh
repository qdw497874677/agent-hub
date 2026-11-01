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
need curl
need tar

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
  need xz
  echo "==> 安装 Node $NODE_MAJOR 到 ~/.local/node$NODE_MAJOR"
  file=""
  for base in "${NODE_DIST:-https://nodejs.org/dist}/latest-v$NODE_MAJOR.x" "https://npmmirror.com/mirrors/node/latest-v$NODE_MAJOR.x"; do
    file="$(curl -fsSL -m 20 "$base/SHASUMS256.txt" 2>/dev/null | awk '{print $2}' | grep -E "^node-v[0-9.]+-linux-$arch\.tar\.xz$" | head -1)" || true
    [[ -n "$file" ]] && break
  done
  [[ -n "$file" ]] || { echo "nodejs.org 上找不到 Node $NODE_MAJOR 的 linux-$arch 包" >&2; exit 1; }
  tmp="$(mktemp -d)"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && curl -fsSL "$base/SHASUMS256.txt" | grep " $file\$" | sha256sum -c - >/dev/null) || { echo "Node 包校验失败" >&2; exit 1; }
  mkdir -p "$HOME/.local/node$NODE_MAJOR"
  tar -xJf "$tmp/$file" -C "$HOME/.local/node$NODE_MAJOR" --strip-components=1
  rm -rf "$tmp"
  export PATH="$HOME/.local/node$NODE_MAJOR/bin:$PATH"
fi

# 最小化镜像（Alibaba Cloud Linux / RHEL / debian-slim）常缺 libatomic.so.1，nodejs.org 的 node 起不来。
# 不需要 sudo：从 Debian 仓库取固定版本的 libatomic1 包（sha256 写死，换哪个镜像都要对得上），
# 用纯 shell 拆 .deb 只取 libatomic.so.1 放进 ~/.local/node26/lib，再把 bin/node 换成带 LD_LIBRARY_PATH 的小壳。
# 这样 npm（#!/usr/bin/env node）、install-worker.sh、systemd 的 ExecStart 走的都是同一个 node。
LIBATOMIC_DEB_VER="12.2.0-14+deb12u1"
LIBATOMIC_MIRRORS="${LIBATOMIC_MIRRORS:-https://deb.debian.org/debian https://mirrors.aliyun.com/debian https://snapshot.debian.org/archive/debian/20250601T000000Z}"
ar_member() { # ar_member <deb> <成员名前缀> <输出>：.deb 是 ar 包，按 60 字节头逐个走
  local f="$1" want="$2" out="$3" off=8 total name size
  total="$(wc -c <"$f")"
  while (( off + 60 <= total )); do
    name="$(dd if="$f" bs=1 skip="$off" count=16 2>/dev/null | tr -d ' ')"
    size="$(dd if="$f" bs=1 skip=$((off + 48)) count=10 2>/dev/null | tr -d ' ')"
    [[ "$size" =~ ^[0-9]+$ ]] || return 1
    if [[ "$name" == "$want"* ]]; then
      tail -c +$((off + 61)) "$f" | head -c "$size" >"$out"
      return 0
    fi
    off=$((off + 60 + size + size % 2))
  done
  return 1
}
fix_libatomic() { # fix_libatomic <node 安装目录>
  local root="$1" deb_arch sum tmp mirror name
  case "$(uname -m)" in
    x86_64) deb_arch=amd64; sum=fbd4e154a6b444229ea002cc209df099209c0adc09102e5fd21239a3d2b55e2d ;;
    aarch64 | arm64) deb_arch=arm64; sum=1693aa13ce2b30d061a519fc28b77b9bab8c8e45804ced5969d99821e1bc2159 ;;
    *) return 1 ;;
  esac
  name="libatomic1_${LIBATOMIC_DEB_VER}_${deb_arch}.deb"
  tmp="$(mktemp -d)"
  for mirror in $LIBATOMIC_MIRRORS; do
    if curl -fsSL -m 60 "$mirror/pool/main/g/gcc-12/${name/+/%2B}" -o "$tmp/l.deb" 2>/dev/null \
      && echo "$sum  $tmp/l.deb" | sha256sum -c - >/dev/null 2>&1; then
      if ar_member "$tmp/l.deb" data.tar "$tmp/data.tar.xz" && mkdir -p "$tmp/x" \
        && tar -xJf "$tmp/data.tar.xz" -C "$tmp/x" 2>/dev/null; then
        local so; so="$(find "$tmp/x" -name 'libatomic.so.1*' -type f | head -1)"
        if [[ -n "$so" ]]; then
          mkdir -p "$root/lib"
          cp "$so" "$root/lib/libatomic.so.1"
          rm -rf "$tmp"
          return 0
        fi
      fi
    fi
  done
  rm -rf "$tmp"
  return 1
}
wrap_node() { # 把 bin/node 换成小壳：先找自带的 lib，再 exec 真的 node
  local root="$1"
  if [[ ! -e "$root/bin/node.real" ]]; then mv "$root/bin/node" "$root/bin/node.real"; fi
  cat >"$root/bin/node" <<'SH'
#!/bin/sh
# agent-hub：这台机器缺 libatomic.so.1，用 ../lib 里自带的那份
here="$(dirname "$(readlink -f "$0")")"
LD_LIBRARY_PATH="$here/../lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" exec "$here/node.real" "$@"
SH
  chmod 755 "$root/bin/node"
}
node_err="$(node -v 2>&1 >/dev/null)" || true
if ! node -v >/dev/null 2>&1; then
  node_root="$(cd "$(dirname "$(command -v node)")/.." && pwd)"
  if [[ "$node_err" == *libatomic.so.1* && "$node_root" == "$HOME/.local/node$NODE_MAJOR" ]]; then
    echo "==> 系统缺 libatomic.so.1，免 sudo 取一份放进 $node_root/lib"
    if fix_libatomic "$node_root"; then wrap_node "$node_root"; fi
  fi
fi
if ! node -v >/dev/null 2>&1; then
  echo "node 跑不起来：" >&2
  node -v 2>&1 | sed 's/^/    /' >&2 || true
  if [[ "$node_err" == *libatomic* ]]; then
    echo "缺系统库 libatomic，自动补装失败。请让管理员装上后重跑同一条命令：" >&2
    echo "    RHEL / Alibaba Cloud Linux / CentOS：sudo yum install -y libatomic" >&2
    echo "    Debian / Ubuntu：sudo apt install -y libatomic1" >&2
  fi
  exit 1
fi
echo "==> Node $(node -v)"

# 代码优先从 hub 取（hub 发的就是它自己正在跑的那个提交，sha256 校验），连不上 GitHub 的机器也能装；
# 有 git 取 .bundle（保留 git 语义：之后的「更新」、启动失败回滚都靠它），没 git 取 .tar.gz 解压。
# hub 取不到才退回 git clone GitHub。
hub_get() { # hub_get <种类 bundle|tar.gz> <输出文件>：下载并校验 sha256
  [[ -n "$HUB_COMMIT" && "$HUB_HTTP" != __HUB_HTTP__ ]] || return 1
  local url="$HUB_HTTP/install/worker-$HUB_COMMIT.$1" sum
  sum="$(curl -fsSL -m 30 "$url.sha256" 2>/dev/null | awk '{print $1}')" || return 1
  [[ "$sum" =~ ^[0-9a-f]{64}$ ]] || return 1
  curl -fsSL -m 600 "$url" -o "$2" 2>/dev/null || return 1
  echo "$sum  $2" | sha256sum -c - >/dev/null 2>&1
}
BUNDLE_REF=refs/agent-hub/install
from_hub=""
tmp_code="$(mktemp -d)"
if command -v git >/dev/null; then
  if hub_get bundle "$tmp_code/w.bundle"; then
    if [[ ! -d "$DIR/.git" ]]; then
      if [[ -e "$DIR" && -n "$(ls -A "$DIR" 2>/dev/null)" && ! -f "$DIR/.agent-hub-commit" ]]; then
        echo "$DIR 已存在且不是 agent-hub 的安装目录；换个 AGENT_HUB_DIR 或先挪走它" >&2; exit 1
      fi
      # 以前用 tar 包装的：换成 git 仓库（node_modules 留着，npm 会对齐）
      [[ -d "$DIR" ]] && find "$DIR" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
      mkdir -p "$DIR"
      git -C "$DIR" init --quiet
      git -C "$DIR" remote add origin "$REPO"
    fi
    if git -C "$DIR" fetch --quiet "$tmp_code/w.bundle" "+$BUNDLE_REF:$BUNDLE_REF" \
      && git -C "$DIR" checkout --quiet -f -B agent-hub-worker "$HUB_COMMIT"; then
      from_hub=1
      echo "==> 代码取自 hub（${HUB_COMMIT:0:7}）"
    fi
  fi
elif hub_get tar.gz "$tmp_code/w.tar.gz"; then
  if [[ -d "$DIR/.git" ]]; then
    echo "$DIR 是 git 仓库但这台机器没有 git：先装 git 再重跑" >&2; exit 1
  fi
  if [[ -e "$DIR" && -n "$(ls -A "$DIR" 2>/dev/null)" && ! -f "$DIR/.agent-hub-commit" ]]; then
    echo "$DIR 已存在且不是 agent-hub 的安装目录；换个 AGENT_HUB_DIR 或先挪走它" >&2; exit 1
  fi
  # 升级：旧文件清掉（node_modules 留着加速 npm），整包解开
  [[ -d "$DIR" ]] && find "$DIR" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
  mkdir -p "$DIR"
  tar -xzf "$tmp_code/w.tar.gz" -C "$DIR"
  echo "$HUB_COMMIT" >"$DIR/.agent-hub-commit"
  from_hub=1
  echo "==> 代码取自 hub（${HUB_COMMIT:0:7}，没有 git：解压安装，远程「更新」需要先装 git 再重跑安装命令）"
fi
rm -rf "$tmp_code"

if [[ -z "$from_hub" ]]; then
  need git
  echo "==> 没能从 hub 取到代码，改从 $REPO 拉取"
  if [[ -d "$DIR/.git" ]]; then
    echo "==> 更新 $DIR"
    git -C "$DIR" fetch --quiet origin
  else
    git clone --quiet "$REPO" "$DIR"
  fi
  if [[ -n "$HUB_COMMIT" ]]; then
    # 和 hub 同一个提交：协议版本天然一致；之后由 hub 的「更新」按钮推着走。
    git -C "$DIR" checkout --quiet -B agent-hub-worker "$HUB_COMMIT" \
      || { echo "仓库里没有 hub 的提交 $HUB_COMMIT（hub 跑的是没推上去的代码？）；先用默认分支" >&2; git -C "$DIR" checkout --quiet origin/HEAD; }
  fi
fi

# npm 源：没指定就用官方；registry.npmjs.org 连不上自动换 npmmirror（install-worker.sh 会写进 worker.env）
if [[ -z "${NPM_CONFIG_REGISTRY:-${npm_config_registry:-}}" ]] && ! curl -fsSI -m 8 https://registry.npmjs.org/ >/dev/null 2>&1; then
  echo "==> registry.npmjs.org 连不上，npm 改用 https://registry.npmmirror.com"
  export NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
fi
[[ -n "${npm_config_registry:-}" && -z "${NPM_CONFIG_REGISTRY:-}" ]] && export NPM_CONFIG_REGISTRY="$npm_config_registry"

export HUB_HTTP HUB_PAIR
[[ -n "${WORKER_INSTANCE:-}" ]] && export WORKER_INSTANCE
exec "$DIR/scripts/install-worker.sh" "$@"
