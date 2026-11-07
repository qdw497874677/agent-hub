# 用 Pi 自带的 OpenCode Go 做测试

这份说明只写不含密钥的配置。不要把 API key 写进仓库、`models.json`、聊天或日志。

核对过的运行时是本机安装的 Pi **1.4.0**（`@earendil-works/pi-coding-agent`）。它**内建** provider `opencode-go`，不需要再写一份 provider 才能认出 Go。

## 环境变量

| 名字 | Pi 1.4.0 是否读取 | 用途 |
| --- | --- | --- |
| `OPENCODE_API_KEY` | 读取。`opencode` 和 `opencode-go` 共用这个名字 | 唯一要注入的密钥。值只放在 Cursor 的 Secrets 里 |
| `OPENCODE_GO_API_KEY` | **不读取**。安装包里没有这个字符串 | 不要靠这个名字；Pi 不会拿它当 Go 的 key |
| `PI_DEFAULT_MODEL` | 读取，形式 `provider/model` | 建议 `opencode-go/kimi-k3`。这是 Pi 给 `opencode-go` 的默认模型 id |

不要配置按量付费地址 `https://opencode.ai/inference`（没有 `/go`）。Go 的官方基址是 `https://opencode.ai/inference/go`（[Harnesses](https://opencode.ai/docs/console/harnesses)）。

Pi 1.4.0 内建目录里，`kimi-k3` 的 API 是 `openai-completions`，`baseUrl` 是 `https://opencode.ai/inference/go/v1`。官方另给 OpenAI 兼容前缀 `https://opencode.ai/inference/go/openai/v1`。用内建 provider 时不要在 `models.json` 里改 `baseUrl`，避免和 Pi 已经写好的路径叠成错误地址。

## 会话头

Go 要求稳定的 `x-opencode-session`。同一份文档写明 Console 认 Pi 自己的会话头，不必再配。Pi 1.4.0 在 provider 为 `opencode` 或 `opencode-go`，或 `baseUrl` 的主机是 `opencode.ai` 时，用当前 `sessionId` 发送 `x-opencode-session`。不要在 `models.json` 里手写这个头，也不要写死某一个 session id。

## 不要提交的 models.json

内建目录已经够用，隔离测试不必再放 `models.json`。如果一定要在隔离 `HOME` 里放一份，`apiKey` 只能是环境变量引用，例如 `"apiKey": "$OPENCODE_API_KEY"`。Pi 的 [models.md](https://github.com/earendil-works/pi/blob/main/docs/models.md) 写明 `$NAME` / `${NAME}` 会在请求时展开。不要写真实 key，不要把这份文件提交进仓库。Pi 1.4.0 包内 `docs/models.md` 写明：带 `models` 数组会替换该 provider 同 id 的模型；只想沿用内建目录时不要再列 `models`。

免费档模型（id 里带 `free` 的，以及文档中的 free-tier）给 Pi 这种外部 harness 会 403。默认用 `kimi-k3`，不要改去点那些免费 id。密钥必须来自已订阅 Go 的 workspace，不是 Pay-as-you-go 的基址。

## 隔离进程里怎么用

和 `docs/testing/isolated-e2e.md` 同一套独立 `HOME` / `HUB_DATA_DIR` / 端口。在这个 HOME 里跑，避免读到别的用户的 `~/.pi`。

```bash
export PI_DEFAULT_MODEL=opencode-go/kimi-k3
# OPENCODE_API_KEY 由启动这个进程的环境注入，这里不要赋值
pi --version
node -e "const k=process.env.OPENCODE_API_KEY; console.log(k ? 'OPENCODE_API_KEY set len='+k.length : 'OPENCODE_API_KEY unset')"
```

第二行只打印有没有值以及长度，不打印 key。未注入时 Pi 的模型目录为空，就绪原因仍是「未配置模型」。有 key 也不要在日志里打印 `pi` 的请求头。
