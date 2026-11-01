# 设计：运行时套件（Runtime Bundle）

- 状态：**accepted**（2026-10-31，David 拍板见 §12，无未决项；只有设计，没有代码）
- 日期：2026-10-31
- 关联：
  - ADR 0021（本设计）；
  - ADR 0010 与 `runtime-install.md`（在 Worker 上装运行时，**本设计在它上面扩展**）；
  - ADR 0013（RuntimeAdapter）；
  - ADR 0016（资产审核）；
  - ADR 0017（权限）；
  - ADR 0020（上下文策略）。

## 0. 结论先说

- **运行时套件** = 运行时本体（例如 pi）+ 可选的生态组件。组件可以是：
  - 运行时插件（pi 扩展，例如 billion-context-pi；opencode 插件）；
  - MCP 服务器；
  - skill。
- 在 Worker 上装运行时时，可以**同时勾选组件**一起装。
- 适配器向 hub 报**清单**：装了哪个运行时、哪些组件、各自什么版本。
- **组件就是资产**，走 ADR 0016 的审核：第三方组件要 `cluster_admin` 审核，锁版本加哈希，**不自动更新**（和 ADR 0020 一致）。
- 组件可以**声明能力**。例如装了 billion-context-pi 的 Worker 提供 `context-strategy:context-pruning@runtime-plugin`。需要某个能力的会话，调度只发给有这个能力的 Worker。

## 1. 现状：运行时现在怎么装（已读代码和文档）

- `docs/design/runtime-install.md`（ADR 0010，已实现）：
  - hub 发 `runtime_job { jobId, agentId, action: install|upgrade|uninstall, version }`，走现有的 WS；
  - Worker 侧每个运行时有一个 `HarnessInstaller`（`install` / `uninstall` / `installed()`），代码在 `packages/node-gateway/src/runtime-jobs.ts`；
  - 安装流程：先装进 `<版本>.staging`，用 shim 跑 `--version` 校验通过后改名，再切换 `current`。失败时删掉 staging，`current` 不动，所以**升级失败自动等于回滚**；
  - hub 用表 `runtime_pins (worker_id, agent_id, version, installed_at, installed_by)` 钉住版本。
- pi：`piInstaller` 用 Worker 自己那个 node 配套的 npm，执行 `npm install --prefix <staging> --omit=dev @earendil-works/pi-coding-agent@<版本>`（`packages/adapters/pi/src/installer.ts`），推荐 1.4.0。
- opencode：只支持 v2 `@opencode/cli`，先 `--ignore-scripts` 装，再只跑它自己的 postinstall。grok：官方脚本，装在临时 HOME 里。
- 权限（ADR 0017）：
  - `runtime.install / uninstall` 在团队 Worker 上，owner 和 admin 是 T，member 只能装自己接入的机器（O）；
  - **本机 Worker 只有 `cluster_admin`**。
- 资产下发（ADR 0016 6B）：装到共享的团队 Worker 要发安装申请，由 Worker 主人批准。
- pi 的 agent 目录：adapter 已经认 `PI_CODING_AGENT_DIR`（`pi-mcp.ts`）。hub 能把扩展装进 hub 管理的目录，不碰用户自己的 `~/.pi`。

本设计**不新开安装通道**：组件安装是 `runtime_job` 的一个新 action，staging / current / 校验 / 回滚这套机制原样复用。

## 2. 调研：运行时自己的组件安装机制

| 运行时 | 机制 | 锁版本 / 自动更新 | 来源 | 核对 |
|---|---|---|---|---|
| pi | `pi install npm:<pkg>@<版本>`、`git:<repo>@<ref>`、本地路径。用户级安装写进 `~/.pi/agent/settings.json`，加 `-l` 写进项目的 `.pi/settings.json`（项目被信任后才读）。管理命令：`pi list` / `pi remove` / `pi update --extensions` | 写了确切版本的 npm 规格**不会被检查更新**；git 的 tag 或 commit 也算钉住。**配置里的包启动时装不上，pi 只告警、跳过、继续运行，下次启动再试** | [pi packages.md](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md) | 已核对 |
| opencode | 插件放在 `.opencode/plugins/` 或全局 `~/.config/opencode/plugins/`；配置里可以写 npm 包（支持 scoped 包）；**opencode 启动时用 `bun install` 安装依赖** | 文档没有讲锁版本，**未核对**；启动时安装意味着可能联网拉包 | [opencode plugins](https://opencode.ai/docs/plugins/) | 部分核对；**和 hub 支持的 v2（`@opencode/cli`）是否兼容，未核对** |
| MCP 服务器 | 已经是 ADR 0016 的资产（stdio 命令 / URL），按会话下发 | 按资产版本 | ADR 0016 | 已有 |
| skill | 已经是 ADR 0016 的资产 | 按资产版本 | ADR 0016 | 已有 |

由此得出的推论：
- 组件**由 hub 预装进 staging**（npm `--prefix`，加 lockfile 和完整性校验），不交给运行时启动时自己装。
- 运行时配置里只写指向本地已装好目录的路径（pi 支持本地路径来源，已核对；opencode 用插件目录），这样运行时启动时不需要联网，也不会悄悄升级。

## 3. 清单格式（manifest）

套件本身也是 ADR 0016 的一种资产（kind `bundle`），只引用组件、不内嵌代码：

```yaml
# bundle：pi-context-pruning
kind: bundle
id: pi-context-pruning
runtime: { agentId: pi, version: "1.4.0" }         # 运行时版本范围必须是确切版本
components:
  - id: billion-context-pi
    kind: runtime-plugin                             # runtime-plugin | mcp-server | skill
    source: { type: npm, package: billion-context-pi, version: "x.y.z", integrity: "sha512-…" }
    install: { target: pi-extension }                # 由适配器解释：pi 扩展目录 / opencode 插件目录
    config: { file: acp.json, template: { autoUpdate: false } }   # 键名未核对，见 §9
    provides:
      - capability: "context-strategy:context-pruning"
        mode: runtime-plugin
    conflicts: ["capability:context-strategy:*"]     # 同一运行时只能有一个上下文插件（ADR 0020）
    requires: { runtime: "pi@>=1.4.0 <2" }
  - id: github-mcp
    kind: mcp-server
    asset: { ref: "asset:github-mcp@3" }             # 直接引用已发布的资产版本
```

- 每个组件在资产里也有一条组件清单：`kind`、`source`（npm / git / 资产引用）、**确切版本和完整性哈希**、`requires`、`provides`、`conflicts`、`install.target`、配置模板。
- 适配器多实现一个方法：`ComponentInstaller.install(component, run) / uninstall / installed()`，形状和 `HarnessInstaller` 一样。

## 4. 安装、卸载、升级的流程

```
用户在「机器 → 运行时 → 安装」里勾选组件
  → hub 解析：版本、依赖（requires）、冲突（conflicts）、权限（§6）、审核状态（只能装 published 的版本）
  → 生成一个 job 计划：[runtime@v] + [component@v…]，按依赖排序
  → runtime_job { action: 'install_bundle', plan }，复用 WS
  → Worker：
      1) 运行时：沿用现有流程（staging → --version 校验 → 切换 current）
      2) 每个组件：装进 components/<id>/<版本>.staging
         → 校验哈希
         → 适配器做冒烟检查（例如 pi 用 `pi list`，或者跑一次 RPC 握手确认扩展加载了，具体检查方式未定）
         → 改名，切换 components/<id>/current
      3) 生成运行时配置（指向本地目录），写进 hub 管理的 agent 目录（pi 用 PI_CODING_AGENT_DIR）
  → Worker 报告每一步的结果 + 新清单（§7）
```

- **卸载组件**：
  - 先检查有没有活动会话正在用它提供的能力。有的话拒绝，或者等这些会话结束（可选「排空后卸载」）；
  - 然后从配置里摘掉，再删目录；
  - 卸载运行时会连带卸载它下面的组件。
- **升级组件**：
  - 新版本必须是已审核通过的 published 版本；
  - 新版本装进 staging，旧的 current 保留；
  - **正在运行的会话继续用旧版本，新会话才用新版本**（ADR 0020 决定 8）；旧版本在没有会话引用时再清理。
- 运行时升级时，按每个组件的 `requires` 重新检查兼容性，不兼容的组件会阻止升级，界面上列出来。

## 5. 失败与回滚

| 情况 | 处理 |
|---|---|
| 运行时装好了，某个组件失败 | 默认**只回滚这个组件**，运行时和其他组件保留，套件标记为「部分安装」并列出原因；勾选「全部或全不」的话就整体回滚，运行时退回旧的 current |
| 哈希不对 | 判为安全失败：不重试，审计 `bundle.integrity_mismatch`，通知 cluster_admin |
| 冒烟检查失败（扩展没加载） | 丢掉 staging，current 不动 |
| 中途断线、取消 | 和 ADR 0010 一样：判为失败，Worker 启动时清掉残留的 staging |
| 配置写入失败 | 配置也先写 staging 文件再原子替换，失败时保留旧配置 |

## 6. 权限（ADR 0017 + ADR 0016）

| 动作 | 自己接入的 Worker（个人） | 共享的团队 Worker | 本机 Worker |
|---|---|---|---|
| 装运行时本体 | 接入人（O） | owner / admin | 只有 cluster_admin |
| 装**已审核的第三方组件**（global，cluster_admin 审过） | 接入人 | owner / admin；成员发安装申请，由 Worker 主人批准（ADR 0016 6B） | 只有 cluster_admin |
| 装 personal 组件（自己写的，不审） | 只能装到自己的 Worker（ADR 0016 1A） | ✗ | ✗ |
| 装 team 组件 | 接入人 | owner / admin（团队审核过） | ✗ |
| 审核第三方组件 / 套件 | — | — | **只有 cluster_admin**（`asset.publish_global`） |

- 新增权限点：`runtime.component.install / uninstall`，映射规则和 `runtime.install / uninstall` 相同；`resource.local` 只看 cluster_admin。
- **第三方**的定义：来源是公共 npm / git、作者不在本 hub 的组件，一律按 global 资产审核，必须 cluster_admin 审核，并且可以打开 2 人审核（ADR 0016 4A）。
- API 令牌不能装组件（加进 `NEVER_GRANTABLE`），理由和 `runtime.install` 一样。

## 7. 清单上报与漂移检测

Worker 在每次连接时、每个 job 完成后、每 6 小时报一次清单：

```ts
interface WorkerInventory {
  runtimes: Array<{ agentId: string; version: string; path: string }>;
  components: Array<{ id: string; runtime: string; version: string; integrity: string; enabled: boolean; managedBy: 'hub' | 'external' }>;
  capabilities: Array<{ capability: string; mode?: string; via: string }>;   // 由 provides 推出来
}
```

- **期望状态**是 hub 的 `runtime_pins` 加新表 `component_pins (worker_id, component_id, version, integrity, installed_by, installed_at)`；**实际状态**是上报的清单。
- 漂移分三类：
  - **缺失**（期望有、实际没有）；
  - **版本或哈希不一致**（有人手动改过，或者运行时自己更新了）；
  - **多出来的外部组件**（用户自己在 `~/.pi` 里装的：`managedBy: external`）。
- 处理办法：
  - 前两类把 Worker 的能力标为「不可信」，**调度不再按这项能力发会话**，界面提示「修复（重新安装）」；
  - 外部组件只显示、不报警，也**不算能力**（hub 没审过）。
- hub 不会自动修复，修复要有权限的人点一下（这样留痕清楚）。

## 8. 能力与调度

- 会话、角色、项目可以声明 `requires: ['context-strategy:context-pruning']` 或 `component:github-mcp`。
- 调度器（`tasks-and-capabilities.md` 里已有的能力匹配）只选**清单里有这项能力、且没有漂移**的 Worker。没有合适的 Worker 时，会话保持「等待 Worker」，界面提示「哪些机器装了这个套件就能跑」，并给出安装入口（有权限的话）。
- 能力里的 `mode`（例如 `runtime-plugin`）对应 ADR 0020 的上下文模式，ContextStrategy 选择时直接使用。

## 9. 安全（供应链）

- **只装 published 版本**：组件的每个版本都走 ADR 0016 审核；Git 或 npm 有新版本时只生成待审提交，**不自动更新**。
- **锁版本和哈希（照常强制）**：npm 用确切版本加 `integrity`（sha512），hub 生成锁文件，Worker 用 `npm ci` 安装；哈希对不上就不装（§5）。git 来源锁到 commit。
- **安装脚本：一律不执行**（David 拍板 8，2026-10-31 修订为跟 paseo 一致，见 ADR 0021「修订」）。Worker 一律用 `--ignore-scripts` 安装，没有例外路径、没有开关：
  - **审核时仍然可见**：审核页列出组件声明的 `preinstall / install / postinstall` 脚本原文，注明「不会执行」，相对上一个批准版本的变化和可疑命令照常高亮；声明了脚本的组件标「有安装脚本 · 可能用不了」；
  - **审计**：装完时依赖树里声明了、但没执行的脚本逐条记 `bundle.script_skipped`，job 日志里也提示；
  - **root Worker**：既然什么都不执行，root 跑的 Worker 也能装；已经以普通用户跑的 Worker 照旧；
  - **代价**：依赖安装脚本才能工作的组件（编译原生模块、下载二进制等）装上了也可能用不了。
- **残余风险**：不执行脚本后，组件代码只在运行时加载它时才执行，仍以 Worker 用户权限运行；哈希只保证「装的就是审过的版本」，不保证那个版本安全，审核仍是主要防线。
- **不让运行时自己拉包**：
  - pi：配置里写本地路径，不写 `npm:` 规格，避免「启动时重装」（pi 文档里写了这个行为）；
  - opencode：不让 bun 在启动时从网络拉包——放进已经装好依赖的插件目录。这一点能否完全做到**未核对**。
- **关掉组件自己的自动更新**：billion-context-pi 的 README 提到更新失败，说明它有更新逻辑，关闭用的配置键名**未核对**。审核清单要求列出「自动更新 / 遥测 / 网络访问」。
- **隔离**：组件装进 hub 管理的目录（`PI_CODING_AGENT_DIR` 等），不写用户的全局配置；组件配置里的密钥只用密钥引用（ADR 0016 第 7 条）。
- **审核依据**：在 ADR 0016 自动生成的风险摘要基础上，增加 npm 依赖树、安装脚本（原文）、维护者、下载量和发布时间等信息；这些只作提示，不替代人审。

## 10. 界面草图（文字）

```
机器详情 → 运行时
┌ pi 1.4.0 ✓ 已安装 ─────────────────────── [升级] [卸载]
│  组件
│   ☑ billion-context-pi x.y.z  ✓  提供：上下文策略 context-pruning（runtime-plugin）
│   ☑ github-mcp v3             ✓
│   ⚠ some-pi-ext 0.3.1  外部安装（不由 hub 管理，不参与调度）
│  [+ 添加组件]
└ 漂移：无   上次清单：10:02 PDT

安装运行时（对话框）
  运行时：pi  版本：1.4.0（推荐）
  可选组件（只显示已审核通过的）：
   ☐ billion-context-pi x.y.z  第三方 · cluster_admin 审核于 10-31 · 网络：有
   ☐ github-mcp v3
  ☐ 全部或全不（任何一项失败就整体回滚）
  [安装]   ← 没有权限时变成「发安装申请」
```

## 11. 分期

| 期 | 内容 |
|---|---|
| P1 | 清单上报（运行时 + 外部组件只读显示），漂移检测的框架；`kind: bundle` 和组件清单的格式；MCP / skill 组件复用现有资产下发 |
| P2 | pi 组件安装（npm 锁版本 + 哈希、本地路径配置、冒烟检查）；`component_pins`；安装、卸载、升级的 job；权限点；能力推导和调度过滤 |
| P3 | opencode 插件组件（先核对 v2 的插件机制）；套件安装对话框；「全部或全不」选项 |
| P4 | git 来源；2 人审核（可选） |

## 12. 决定（David，2026-10-31，全部已决）

1. **安装通道**：复用 `runtime_job` 加新 action，沿用 staging / current / 回滚。
2. **谁来装组件**：hub 预装到本地目录，运行时配置只写本地路径，运行时不联网拉包。
3. **部分失败**：默认只回滚失败的组件，可选「全部或全不」。
4. **第三方组件审核**：一律按 global 资产审核，只有 cluster_admin 能审，可选 2 人审核。
5. **外部安装的组件**：只显示，不参与调度，不报警。
6. **漂移处理**：能力标为不可信，调度跳过，修复要人工触发。
7. **升级生效**：新版本只对新会话生效，旧版本在没有会话引用时清理。
8. **安装脚本**：**一律不执行**（2026-10-31 修订：跟 paseo 一致，理由是供应链风险）。审核页展示脚本原文仅供参考并标「可能用不了」；没执行的脚本记审计；哈希锁定照常强制；不再有「禁止安装脚本」开关。原决定（默认允许 + 开关）已作废。

实施顺序（David 2026-10-31 同意）：消息 P2P 核心 → 记忆 P1 → IM / 群聊 → 上下文策略和运行时套件（本设计在最后一档）。

### 12.1 未决

无。
