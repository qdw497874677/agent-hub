# 视觉方向：深色控制室

状态：草案 v1。配套 [定位](../product/positioning.md)、[技术选型](../architecture/tech-stack.md)、原型图 `docs/design/mockups/`

深色为**默认皮肤**。浅色（暖纸）不做调度，留作 T2 跟随系统刷新。理由：深色是用户选的默认；浅色皮肤在画布上更好看但纸白大面积发光会让人在长时间使用后先累眼睛，两套同时维护的代价在 v1 不值得付。

## 1. 气质

1970 年代的**控制室**，不是 1990 年代的终端。区别在两处：控制室的每一根线与每一格字都对齐在同一套基线上，而终端风靠字符堆叠。所以：

- **对齐全靠网格与发丝线，不靠边框和阴影。** 没有卡片阴影，没有圆角大于 6px 的容器，没有玻璃拟态。
- **强调色只有一个，且只给"此刻正在发生的事"。** 琥珀 `#D9A05B` 只用于：运行中、选中、流式光标、可点主操作。别处一律灰绿。
- **复古感来自三处**：等宽字体的元数据、正交（非曲线）连线、图纸式的线型图例。不来自扫描线、噪点、霓虹。

## 2. 色板

| Token | 值 | 用途 |
|---|---|---|
| `--bg-canvas` | `#14181A` | 无限画布底 |
| `--bg-panel` | `#1B2022` | 左右栏、顶栏 |
| `--bg-card` | `#1F2528` | 会话卡片 |
| `--bg-card-raised` | `#242B2E` | 悬停、输入框、代码块 |
| `--line-hair` | `#2E3639` | 发丝线、分隔线（1px，永远 1px） |
| `--line-strong` | `#3C4649` | 派生连线、卡片外框 |
| `--text-primary` | `#E8E3D9` | 对话正文（暖白，不用纯白） |
| `--text-secondary` | `#9AA39E` | 标签、次要信息 |
| `--text-tertiary` | `#6B7570` | 元数据、时间戳、禁用 |
| `--accent` | `#D9A05B` | 运行中 / 选中 / 光标 / 主操作 |
| `--accent-dim` | `#8A6A3D` | 产出点线、accent 的次级引用 |
| `--sage` | `#6E8C80` | 完成、在线、分叉虚线 |
| `--muted-rust` | `#8C6A55` | 中断（终态但不成功） |

`--text-tertiary` 只用于元数据与≥12px 的等宽字样，不用于正文。正文最低 `--text-secondary`。

## 3. 四种线型（画布的图纸语言）

线条区分关系类型，**不依赖颜色**（色盲可用）：

| 关系 | 线型 | 颜色 | 图例字符 |
|---|---|---|---|
| 派生 `derive`（Task → Session） | 实线 1px | `--line-strong` | `───` |
| 分叉 `fork`（Session → Session） | 虚线 6/4 | `--sage` | `- - -` |
| 产出 `artifact`（Session → Artifact） | 点线 2/4 | `--accent-dim` | `·····` |
| 选中路径 | 实线 1.5px | `--accent` | `━━━` |

**正交布线**：连线走直角 + 6px 圆角过渡，不走贝塞尔。这是从蓝图方向借来的唯一一处，理由是血缘图读的是"从谁到谁"，曲线会让人误读为"强弱"。

图例（左下角）常驻，不折叠。

## 4. 排版

| 角色 | 字体 | 字号/行高 |
|---|---|---|
| 中文正文与标题 | 思源黑体 / Noto Sans SC | 13 / 1.55 |
| 拉丁 UI 与标题 | Inter Tight | 同上 |
| 元数据、代码、时间戳、编号 | IBM Plex Mono | 11 / 1.5 |

**不用宋体。** 宋体在深色底上笔画发虚——原型图 C 里的宋体之所以成立，是因为底色是纸。深色皮肤的"高级"由**字距与对齐**承担，不由衬线承担。

字号阶梯：11（元数据）/ 12（标签）/ 13（正文）/ 15（区块标题）/ 20（页面标题）。**没有 14，没有 16**——偶数行高与 4px 基线才对齐得上。

## 5. 结构尺寸

| 件 | 尺寸 |
|---|---|
| 左侧图标栏 | 56px |
| 顶栏 | 48px |
| 右侧检查器 | 320px（可折叠到 0） |
| 会话卡片宽 | 320px（固定，不随缩放改变） |
| 会话卡片高 | 自适应，最小 180，超过 520 内部滚动 |
| 卡片圆角 / 内距 | 6px / 12px |
| 节点间距 | 24px（同级），64px（跨 Task） |
| 画布点阵 | 24px 间距，1px 点，`--line-hair` |

## 6. 会话卡片的三种块型

卡片默认渲染**对话流**，不是事件流。这是设计上最容易搞错的一处——原型图 A 把 journal 的 `INFO` 行直接画在卡片上，那是开发者的视角。

| 块型 | 呈现 |
|---|---|
| 对话 | 正文 13px，用户侧 `--text-primary`，agent 侧 `--text-secondary`（对话里人不该被压过 agent，但结构上要能区分） |
| 工具调用 | 单行等宽条，1px 发丝外框，左侧小方块图标 + `执行 bash · 3.2s` |
| 代码 / 产出 | `--bg-card-raised` 底，左侧 1px 竖线，等宽 11px |

**事件流（journal）默认不可见**，通过卡片右上角的 `•••` 展开为底部抽屉。它是诊断用的，不是阅读用的。

流式光标：`--accent` 实心方块 6×13px，1s 阶跃闪烁（`step-end`，不淡出——淡出会像呼吸灯，阶跃才像打字机）。

## 7. 状态位

所有状态显示在**卡片的固定位置**（头部右侧），不做悬浮标签：

| 状态 | 呈现 |
|---|---|
| 运行中 | `--accent` 实心点 + 「运行中」 |
| 完成 | `--sage` 空心圆 + 「完成」 |
| 中断 | `--muted-rust` 方块 + 「中断」 |
| 失败 | `--muted-rust` 方块 + 「失败」+ 原因一行 |
| 离线 Worker 上的会话 | 整卡 `opacity: 0.5` + 「不可达」 |

「中断」与「运行中」占同一位置、同样字号，这是 S7.1 的视觉实现：重开浏览器后，那个位置必须诚实地显示「中断」。

## 8. 能力矩阵的三态

布尔不够用。三态 + 原因：

| 态 | 记号 | 颜色 | 说明 |
|---|---|---|---|
| `available` | ✓ | `--sage` | 可用 |
| `limited` | ✓ | `--accent` | 可用但有条件，行尾给原因 |
| `denied` | — | `--text-tertiary` | 不可用，行尾给原因（**不隐藏行**） |

矩阵形状因此定为 `{ state: 'available' | 'limited' | 'denied', reason?: string }`，`reason` 在 `limited` / `denied` 时必填。这条已写进 `contract` 的待办。

## 9. Tailwind v4 令牌

```css
@theme {
  --color-canvas: #14181A;
  --color-panel: #1B2022;
  --color-card: #1F2528;
  --color-card-raised: #242B2E;
  --color-hair: #2E3639;
  --color-line: #3C4649;
  --color-ink: #E8E3D9;
  --color-ink-2: #9AA39E;
  --color-ink-3: #6B7570;
  --color-accent: #D9A05B;
  --color-accent-dim: #8A6A3D;
  --color-sage: #6E8C80;
  --color-rust: #8C6A55;

  --font-sans: "Inter Tight", "Noto Sans SC", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;

  --text-meta: 11px;
  --text-label: 12px;
  --text-body: 13px;
  --text-heading: 15px;
  --text-title: 20px;

  --radius-card: 6px;
  --spacing-canvas-dot: 24px;
}
```

React Flow 的边样式不要用内置曲线，走 `step` 类型 + 自定义 `style: { stroke, strokeDasharray }`，颜色与线型从上表取。
