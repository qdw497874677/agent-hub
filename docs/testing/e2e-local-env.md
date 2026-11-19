# 本机补齐 E2E 环境（node-pty、OpenCode v2 + Hub glm-5.3-flash）

完整 E2E 里有两类用例以前在 box 上总是「环境失败」：

| 用例 | 以前失败的原因 | 补什么 |
|---|---|---|
| `terminal-mobile.spec.ts`（3 条） | `node-pty` 是 `packages/node-gateway` 的可选依赖，机器上没有 `make` / `g++`，`npm ci` 编不出来就静默跳过，终端一直连不上 | 装编译工具，重新 `npm ci` |
| `opencode-commands.spec.ts`、`opencode-subagent.spec.ts` | 写死了本机 OpenCode 的 `my-codex/go-deepseek-v4.1-flash`（Go 模型）；E2E 的 PATH 里也没有 opencode | 装 OpenCode v2，隔离 HOME 里放一份只含编排者 / explorer 的配置，用 `E2E_HUB_MODEL` 走 Hub 托管模型 |

`agent-profiles.spec.ts:29` 是代码问题（#238），不在这里处理。

## 1. node-pty

```bash
# Debian 13。box 上 deb.debian.org 的 http 走不通，换成能访问的 https 镜像；不改系统 sources，只在这一次用
mkdir -p /tmp/aptsl
sed 's#http://deb.debian.org#https://mirrors.aliyun.com#' /etc/apt/sources.list.d/debian.sources > /tmp/aptsl/debian.sources
sudo apt-get -o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts=/tmp/aptsl update
sudo apt-get -o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts=/tmp/aptsl install -y build-essential python3

# 用跑 Hub / Worker / E2E 的同一个 Node（本仓库现在是 Node 26）重新装依赖，node-pty 会用 node-gyp 编出来
npm ci
node -e "const p=require('node-pty');const t=p.spawn('/bin/echo',['pty-ok'],{});t.onData(d=>process.stdout.write(d))"
```

看到 `pty-ok` 就行。换了 Node 大版本要重新 `npm ci`（或 `npm rebuild node-pty`）。

## 2. OpenCode v2 + Hub 模型

用例依赖 OpenCode v2 的能力（ADR 0034：`opencode/child-session-updates`、`<subagent … state=…>`），1.x 跑不出子代理卡。装到单独目录，不动全局的 opencode：

```bash
D=/workspace/tools/opencode-v2   # 任意目录
mkdir -p "$D"
npm install --prefix "$D" --no-audit --no-fund --omit=dev --ignore-scripts @opencode/cli@2.3.2
(cd "$D/node_modules/@opencode/cli" && npm run postinstall)
"$D/node_modules/@opencode/cli/bin/opencode.exe" --version   # opencode v2.3.2
```

E2E 进程的 PATH 里要有名为 `opencode` 的这个二进制（例如在隔离目录的 `bin/` 里建软链），Worker 才会上报 opencode 运行时，并按 `--version` 选 v2 配置方言。

隔离 HOME 里放 `e2e/fixtures/opencode-isolated.json`：

```bash
mkdir -p "$HOME/.config/opencode"
cp e2e/fixtures/opencode-isolated.json "$HOME/.config/opencode/opencode.json"
```

这份配置做三件事：

- `disabled_providers: ["opencode", "opencode-go"]`：OpenCode 自带的 Zen / Go 供应商不出现，会话里唯一能选的就是 Hub 通过 `OPENCODE_CONFIG_CONTENT` 注入的 `hub-<标识>`。
- 定义 `orchestrator`（primary）和 `explorer`（subagent）：用例派生时用 `mode: orchestrator`，并要求子代理卡里出现 explorer。OpenCode v2 自带的只有 build / plan。
- `autoupdate: false`。

然后照 [hub-glm-e2e.md](hub-glm-e2e.md) 设置 `E2E_HUB_MODEL=hub-cn-glm-flash/glm-5.3-flash`（密钥只在测试进程里）。设置了这个变量时，两条 OpenCode 用例改用 Hub 模型，只要求 Worker 报了 opencode 运行时（Hub 模型不在 Worker 的原生模型清单里）；没设置时保持原来的 `my-codex/...` 写法，给装了那套本机供应商的真机用。

**不要**用非隔离的 HOME 跑：box 上 `~/.config/opencode/opencode.json` 的默认模型是 Go 模型，`~/.pi` 的默认模型也是。

### 收尾

OpenCode v2 的 `acp` 会在当前 HOME 下拉起一个后台服务（`opencode serve --service`），E2E 结束后它还在。跑完按 HOME 找出来停掉：

```bash
for p in $(pgrep -f 'opencode.exe serve --service'); do
  tr '\0' '\n' < /proc/$p/environ | grep -qx "HOME=$HOME" && kill "$p"
done
```

## 3. 核对

- 会话用的模型：Hub 库里 `sessions.model` 都是 `hub-cn-glm-flash/glm-5.3-flash`；OpenCode 自己的 `~/.local/share/opencode/opencode.db` 里消息的 `providerID` 只有 `hub-cn-glm-flash`（库里的模型目录缓存会列出别的供应商名字，那只是目录，不是调用）。
- 单跑：`terminal-mobile.spec.ts` 3/3，`opencode-commands.spec.ts` + `opencode-subagent.spec.ts` 2/2。
