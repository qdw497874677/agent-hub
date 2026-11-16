# 资产组合（AssetSet）

状态：已落地（2026-11-16）。相关：`docs/design/assets.md`、`docs/design/external-surface.md` §5。

## 解决什么

资产配置原本只有两条路：项目生效集（逐个开关）或会话临时 `assetIds`。同一套技能要在每个项目里重配，会话里也看不出「这些资产是哪来的」。组合把常用资产打成一份可复用的清单：

- 资产中心里建一次，多个项目引用；
- 项目设置里选默认组合（有序、可叠加）；
- 派生时可以换组合或临时排除某一项；
- 开会话时仍冻结成快照，已在跑的会话不会被组合改动影响。

## 模型

```ts
interface AssetSet {
  id: 'aset_<8hex>';
  teamId: string;
  name: string;              // 团队内唯一，≤60
  description: string | null; // ≤300
  items: { assetId: string }[]; // ≤50，去重保序
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}
```

- 组合是**团队级**的：成员只能往里放自己看得见的资产；改/删限创建者或团队 owner/admin。
- 组合保存的是「资产 id」，不锁版本。锁定版本仍由会话快照负责（`docs/design/assets.md` D2/D3）。
- 项目只存 `assetSetIds: string[]`（≤8，顺序有意义），不复制组合内容。

## 解析顺序

会话启动时（以及派生前预览）：

1. 计算项目生效集（全局 / 团队 / 项目 / 个人，按现有作用域优先级）。
2. 按 `assetSetIds` 顺序依次展开组合，把组合里的资产并入候选池；**同名资产后面的组合覆盖前面的组合**。
3. 组合里的资产会覆盖项目生效集里的同类同名资产（组合是更明确的意图）；组合之间后者覆盖前者。
4. 只有「已装到目标机器」的资产进入下发清单。
5. 若会话显式给了 `assetIds`，最后再按它过滤（这是最外层，用于临时排除单项）。

唯一的解析入口是 domain 的 `resolveSessionAssets`（`packages/domain/src/use-cases/assets.ts`）：
下发（`session-environment.planFor`）与派生前预览（`GET /api/projects/:id/assets`）都走它，
区别只在「谁是发起人」：

- 下发：用会话的 `createdBy`（`sessionOwner`），与任务 owner 无关。
- 派生预览：会话还不存在，按约定「发起这次派生的人就是未来的 owner」计算。
  若实际创建的会话属于别人，以会话的 `createdBy` 为准。

组合的来源优先级：

```
会话显式 assetSetIds  >  项目默认 assetSetIds  >  不使用组合
```

- 不传 `assetSetIds`：用项目默认组合。
- 传空数组：这次不带任何组合（仍用项目生效集）。

删除组合前只检查项目引用：仍被项目引用返回 409「还有 N 个项目在用它，先解绑」。
会话里显式写下的 `assetSetIds` 不阻止删除；该组合不存在时解析会跳过它并记日志，
下一次启动按剩余组合 + 项目生效集计算。
- 组合里引用了当前项目看不见的资产（跨项目 project 作用域、别人的 personal）会被丢弃，不报错。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/asset-sets` | 团队内组合列表 |
| POST | `/api/asset-sets` | 新建（`{ name, description?, items }`） |
| PATCH | `/api/asset-sets/:id` | 改名/换资产 |
| DELETE | `/api/asset-sets/:id` | 删除；仍被项目引用时 409 |
| PATCH | `/api/projects/:projectId` | 带 `assetSetIds` 设置项目默认组合 |
| GET | `/api/projects/:projectId/assets?workerId=` | 派生预览（已按组合展开） |

审计：`asset.set_create` / `asset.set_update` / `asset.set_remove`。

## 界面

- 资产中心「组合」：列表、新建/编辑（名称、说明、资产多选）、删除确认。
- 项目设置「代码与工作目录」：默认组合有序多选，可上下调序。
- 派生对话框：组合 chip（默认勾选项目组合，可取消/更换），下方资产逐项勾选；组合只解释来源，排除单项仍走 `assetIds`。

## 不做

- 组合版本化（组合是活配置，改动影响下一次会话；快照保证旧会话不漂）。
- 组合嵌套组合。
- 跨团队共享（要共享就放到团队或全局作用域资产，再引用）。
- 组合级权限（沿用资产可见性 + 团队边界）。

## 验收

1. 建一个含两个技能的团队组合，在项目里设为默认；派生会话的快照出现两项，`source: 'set'`。
2. 同一项目再引用第二个组合，同名资产以后一个为准。
3. 派生时取消组合 → 快照不含组合资产，但项目生效集仍在。
4. 派生时取消某个单项 → 该资产不在快照，其余不变。
5. 删除仍被项目引用的组合 → 409 并说明还有几个项目在用。
