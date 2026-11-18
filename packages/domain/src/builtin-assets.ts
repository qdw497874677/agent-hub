import type { Asset, AssetKind } from './asset.ts';

/**
 * Hub 内置资产清单（随代码发版）。每一项写死来源和钉住的版本：
 * - MCP 只写 npm / PyPI 的确切版本（`包@版本`），或官方托管的远程地址；
 * - 技能 / 指令是本仓库自己写的内容（不搬第三方文本，免得带许可证义务）。
 * 升级 = 改这里的 version 和内容、发版；已启用的项目还用自己锁住的那一版，界面提示「有新版本」，主人点了才换。
 */

export interface BuiltinSecret {
  /** 密钥名（`${secret:NAME}` 里的 NAME）。 */
  readonly name: string;
  readonly label: string;
  /** 去哪拿、要什么权限：一句话。 */
  readonly hint: string;
  readonly url?: string;
}

export interface BuiltinSource {
  /** 给人看的来源：包名@版本 / 仓库。 */
  readonly label: string;
  readonly url: string;
  readonly license: string;
}

export interface BuiltinAsset {
  /** 稳定 id：资产来源里记的就是它，改名不影响已启用的项目。 */
  readonly id: string;
  readonly kind: AssetKind;
  /** 落到项目里的资产名（mcp.json 的 name / 技能目录名 / 指令文件名）。 */
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  /** 清单版本：和上游版本对应；内容变了就要改。 */
  readonly version: string;
  readonly source: BuiltinSource;
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly secrets: readonly BuiltinSecret[];
  /** 机器上要有的东西（hub 能管的只有浏览器）。 */
  readonly requires?: { readonly browser?: 'chromium' };
  /** hub 管不了、只能提示的前提（例如机器上要有 uv）。 */
  readonly note?: string;
  /** 配套的其他内置项（只做提示）。 */
  readonly pairsWith?: readonly string[];
}

/**
 * 浏览器组件：走组件目录装 playwright-core（和 @playwright/mcp 依赖的同一个版本，浏览器修订号才对得上），
 * 装完 Worker 再用它自己的命令下载 Chromium 到默认位置（~/.cache/ms-playwright），npx 起的 Playwright MCP 就能找到。
 * 组件安装一律不跑包里的安装脚本；下载浏览器这一步是 Worker 代码里写死的（只认这个包 + 这个能力）。
 */
export const BUILTIN_CHROMIUM = {
  componentId: 'chromium',
  packageName: 'playwright-core',
  version: '1.66.0-alpha-2026-11-09',
  integrity: 'sha512-HZVc/E3nqrasH7PPvJNwc7aCNsKXKjvtViZBpeFfopGOeB0zr3r5q4TKfqzkrdIcCKWCulyLVVGtla/LYbmxUQ==',
  license: 'Apache-2.0',
  capability: 'browser:chromium',
  /** 不是运行时插件：不交给 agent 当扩展加载。 */
  mode: 'machine-tool'
} as const;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const WEB_TESTING = `---
name: web-testing
description: 用浏览器验收网页改动：启动预览、按用户路径点一遍、截图留证、把问题写清楚。需要 playwright MCP。
---

# 网页验收

改了前端就要在真浏览器里看一遍，别只看代码。

## 步骤

1. **先跑起来**：用项目自己的命令启动开发服务器（看 package.json 的 scripts），记下地址。
2. **按用户路径走**：用 playwright 工具打开页面（\`browser_navigate\`），先 \`browser_snapshot\` 读页面结构，再按真实用户的顺序点击、输入、提交。
3. **每一步都验证**：操作后重新读快照，确认文字、按钮状态、跳转是否符合预期；有报错就看 \`browser_console_messages\`。
4. **两种宽度**：桌面（1280）和手机（390）各看一遍，重点看溢出、遮挡、按钮够不够大。
5. **截图留证**：关键状态用 \`browser_take_screenshot\` 存下来，汇报时附上。

## 汇报

- 通过的路径一句话带过；
- 失败的写清：在哪个页面、做了什么、期望什么、实际看到什么、截图；
- 不确定的说不确定，别猜。

## 注意

- 只测本地或测试环境，不要在生产数据上点删除、付款之类的按钮。
- 页面要登录时，用测试账号；不要把密码写进代码或日志。
`;

const FRONTEND_DESIGN = `---
name: frontend-design
description: 写或改界面时的设计准则：先用现有组件和设计令牌，文案短而具体，桌面和手机都要能用。
---

# 前端设计准则

## 先复用

- 先找项目里已有的组件、颜色 / 字号 / 间距令牌，照着用；不要新造一套按钮或配色。
- 同一种操作在全站长得一样、放在一样的位置。

## 信息层级

- 一屏只有一个主要操作，其余降级成次要按钮或菜单。
- 标题说清这是什么，辅助文字说清下一步；能删的字都删掉。
- 空状态告诉用户怎么开始，错误提示说清原因和怎么办，不要只写「出错了」。

## 交互

- 危险操作（删除、吊销、覆盖）要二次确认，并说清后果。
- 异步操作要有进行中状态，按钮防重复点击。
- 表单校验就地提示，不要等提交后才一次性报错。

## 适配与可用性

- 桌面和 390px 手机都要能用：不横向溢出，点击区域不小于 32px。
- 文字和背景对比度足够；图标按钮要有可读的名字（aria-label）。
- 支持键盘：Tab 能走到，Enter / Esc 行为符合预期。

## 交付前

- 两种宽度各截一张图自查；有改动前后对比更好。
`;

const CODE_STANDARDS = `# 团队代码规范（模板）

> 内置模板：启用后在项目里改成你们团队自己的规则。

## 提交

- 小步提交，一个提交只做一件事；提交说明写「为什么」，不只写「改了什么」。
- 不提交密钥、令牌、个人配置；发现误提交立即轮换密钥。

## 代码

- 先读懂周围代码的写法再动手，命名、结构、错误处理跟现有风格一致。
- 不留无用代码和注释掉的代码；注释解释「为什么」，不复述代码。
- 新增依赖前先确认项目里没有现成的；锁定版本。

## 测试

- 改行为就改 / 加测试；修 bug 先写能复现的测试。
- 提交前跑项目的检查命令（类型检查、单元测试、lint），全绿再交。

## 评审

- PR 描述写清改动、风险、怎么验证；界面改动附截图。
- 评审意见对事不对人；有分歧时以可验证的事实（测试、数据）决定。
`;

export const BUILTIN_ASSETS: readonly BuiltinAsset[] = [
  {
    id: 'playwright',
    kind: 'mcp',
    name: 'playwright',
    title: 'Playwright 浏览器',
    summary: '让 agent 打开网页、点击、填表、截图、读页面结构，适合验收前端改动。',
    version: '0.0.85',
    source: { label: '@playwright/mcp@0.0.85（Microsoft）', url: 'https://www.npmjs.com/package/@playwright/mcp/v/0.0.85', license: 'Apache-2.0' },
    files: [
      {
        path: 'mcp.json',
        text: json({
          name: 'playwright',
          description: '浏览器自动化（Playwright）：打开页面、点击、输入、截图、读页面结构',
          command: 'npx',
          args: ['-y', '@playwright/mcp@0.0.85', '--headless', '--isolated', '--browser', 'chromium']
        })
      }
    ],
    secrets: [],
    requires: { browser: 'chromium' },
    pairsWith: ['web-testing']
  },
  {
    id: 'github',
    kind: 'mcp',
    name: 'github',
    title: 'GitHub（只读）',
    summary: '查仓库、代码、Issue、PR 和 Actions。默认只读；要写操作请自己建一份资产。',
    version: 'remote-readonly-1',
    source: { label: 'GitHub 官方 MCP 远程服务（github/github-mcp-server）', url: 'https://github.com/github/github-mcp-server', license: 'MIT' },
    files: [
      {
        path: 'mcp.json',
        text: json({
          name: 'github',
          description: 'GitHub 官方 MCP（只读）：仓库、代码、Issue、PR、Actions',
          url: 'https://api.githubcopilot.com/mcp/readonly',
          headers: { Authorization: 'Bearer ${secret:GITHUB_TOKEN}' }
        })
      }
    ],
    secrets: [
      {
        name: 'GITHUB_TOKEN',
        label: 'GitHub 访问令牌',
        hint: '在 GitHub 建一个细粒度令牌，只勾需要的仓库，权限给只读即可',
        url: 'https://github.com/settings/personal-access-tokens/new'
      }
    ]
  },
  {
    id: 'context7',
    kind: 'mcp',
    name: 'context7',
    title: 'Context7 文档',
    summary: '按库名查最新的官方文档和示例代码，减少 agent 用过时的 API。',
    version: '4.6.0',
    source: { label: '@upstash/context7-mcp@4.6.0（Upstash）', url: 'https://www.npmjs.com/package/@upstash/context7-mcp/v/4.6.0', license: 'MIT' },
    files: [
      {
        path: 'mcp.json',
        text: json({
          name: 'context7',
          description: '查第三方库的最新文档和示例（Context7）',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp@4.6.0']
        })
      }
    ],
    secrets: []
  },
  {
    id: 'fetch',
    kind: 'mcp',
    name: 'fetch',
    title: '网页抓取',
    summary: '抓一个网址的内容并转成 Markdown，给 agent 读文档、读页面用。',
    version: '2026.11.11',
    source: { label: 'mcp-server-fetch==2026.11.11（Model Context Protocol 官方）', url: 'https://pypi.org/project/mcp-server-fetch/2026.11.11/', license: 'MIT' },
    files: [
      {
        path: 'mcp.json',
        text: json({
          name: 'fetch',
          description: '抓取网址内容并转成 Markdown',
          command: 'uvx',
          args: ['mcp-server-fetch==2026.11.11']
        })
      }
    ],
    secrets: [],
    note: '机器上要有 uv（uvx）'
  },
  {
    id: 'web-testing',
    kind: 'skill',
    name: 'web-testing',
    title: '网页验收',
    summary: '教 agent 按用户路径在真浏览器里验收改动、截图留证。配合 Playwright 使用。',
    version: '1',
    source: { label: 'Agent Hub 内置', url: 'https://github.com/qdw497874677/agent-hub', license: '随 Agent Hub' },
    files: [{ path: 'SKILL.md', text: WEB_TESTING }],
    secrets: [],
    pairsWith: ['playwright']
  },
  {
    id: 'frontend-design',
    kind: 'skill',
    name: 'frontend-design',
    title: '前端设计准则',
    summary: '写界面时先复用现有组件和令牌，文案短而具体，桌面和手机都要能用。',
    version: '1',
    source: { label: 'Agent Hub 内置', url: 'https://github.com/qdw497874677/agent-hub', license: '随 Agent Hub' },
    files: [{ path: 'SKILL.md', text: FRONTEND_DESIGN }],
    secrets: []
  },
  {
    id: 'code-standards',
    kind: 'instruction',
    name: 'code-standards',
    title: '团队代码规范模板',
    summary: '提交、代码、测试、评审的基本规则。启用后可以按团队习惯改。',
    version: '1',
    source: { label: 'Agent Hub 内置', url: 'https://github.com/qdw497874677/agent-hub', license: '随 Agent Hub' },
    files: [{ path: 'code-standards.md', text: CODE_STANDARDS }],
    secrets: []
  }
];

export const builtinById = (id: string): BuiltinAsset | null => BUILTIN_ASSETS.find((item) => item.id === id) ?? null;

/** 资产来自哪一项内置（不是内置的返回 null）。 */
export function builtinOf(asset: Pick<Asset, 'source'>): { item: BuiltinAsset | null; version: string } | null {
  if (asset.source.type !== 'builtin') return null;
  return { item: builtinById(asset.source.id), version: asset.source.version };
}

/** 内置资产有没有新版本：清单里的版本和项目锁住的不一样就算。 */
export function builtinUpdateAvailable(asset: Pick<Asset, 'source'>): string | null {
  const of = builtinOf(asset);
  if (!of?.item) return null;
  return of.item.version === of.version ? null : of.item.version;
}

/** 这台机器缺不缺内置资产要的浏览器（只认 hub 装的、可信的 browser:chromium 能力）。 */
export function needsBrowser(item: Pick<BuiltinAsset, 'requires'> | null, trustedCapabilities: readonly string[]): boolean {
  if (!item?.requires?.browser) return false;
  return !trustedCapabilities.includes(BUILTIN_CHROMIUM.capability);
}
