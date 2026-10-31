import type { Asset, AssetKind, AssetScope, AssetRevision, ProjectAssetSettings, SessionAssetManifest } from '../asset.ts';

/** 资产 + 版本 + 内容 blob + 「哪台 Worker 装了哪些」。blob 按 sha256 寻址，写入幂等。 */
export interface AssetRepository {
  list(): Promise<Asset[]>;
  get(id: string): Promise<Asset | null>;
  /** 同类、同作用域（null = 全局）里按名字找。 */
  byName(kind: AssetKind, name: string, projectId: string | null): Promise<Asset | null>;
  /** 同类、同作用域（ref 见 assetScopeRef）里按名字找。 */
  findInScope(kind: AssetKind, name: string, scope: AssetScope, ref: string): Promise<Asset | null>;
  /** 新建资产连同它的第一个版本（同一事务）。 */
  create(asset: Asset, revision: AssetRevision, blobs: ReadonlyMap<string, Uint8Array>): Promise<void>;
  /** 追加一个版本（同 digest 已存在则不动）。 */
  addRevision(revision: AssetRevision, blobs: ReadonlyMap<string, Uint8Array>): Promise<void>;
  /** 新的在前。 */
  revisions(assetId: string): Promise<AssetRevision[]>;
  revision(assetId: string, digest: string): Promise<AssetRevision | null>;
  /** 改钉住 / 最新版本、描述、作用域与归属。 */
  update(asset: Asset): Promise<void>;
  /** 连同版本、安装关系一起删；不再被引用的 blob 一并清掉。 */
  remove(id: string): Promise<void>;
  blob(sha256: string): Promise<Uint8Array | null>;
  installations(): Promise<{ workerId: string; assetId: string }[]>;
  install(workerId: string, assetId: string, at: number): Promise<void>;
  uninstall(workerId: string, assetId: string): Promise<void>;
  /** 项目设置里的资产开关（只存改过默认值的那些）。 */
  projectSettings(projectId: string): Promise<ProjectAssetSettings>;
  /** enabled = null 表示回到默认。 */
  setProjectSetting(projectId: string, assetId: string, enabled: boolean | null): Promise<void>;
  /** 记下一次会话启动时给出的资产清单（同一会话再启动 = 覆盖成最新那次）。 */
  recordSessionAssets(manifest: SessionAssetManifest): Promise<void>;
  sessionAssets(sessionId: string): Promise<SessionAssetManifest | null>;
}
