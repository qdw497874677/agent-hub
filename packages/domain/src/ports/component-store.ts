import type { CatalogComponent, WorkerComponentPin } from '../component-catalog.ts';

/** 组件目录（cluster_admin 审核的 npm 制品）。 */
export interface ComponentCatalogRepository {
  list(): Promise<CatalogComponent[]>;
  byId(id: string): Promise<CatalogComponent | null>;
  save(item: CatalogComponent): Promise<void>;
}

/** 每台机器上钉住的组件（期望状态）。同步读：网关每次描述 Worker 时都要算漂移。 */
export interface ComponentPinStore {
  pinsFor(workerId: string): WorkerComponentPin[];
  upsert(pin: WorkerComponentPin): void;
  remove(workerId: string, componentId: string, runtime: string): void;
}
