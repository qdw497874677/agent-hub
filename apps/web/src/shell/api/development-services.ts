import { call, post } from './http.ts';
import type { DevelopmentService, DevelopmentWorker } from '../../atoms/development-service-model.ts';

export type { DevelopmentService, DevelopmentWorker } from '../../atoms/development-service-model.ts';
export interface DevelopmentGroup { workspaceId: string | null; name: string; services: DevelopmentService[] }
export interface DevelopmentWorkerDetail { state: 'ready' | 'offline' | 'unavailable'; manualAvailable: boolean; groups: DevelopmentGroup[] }
export const developmentServicesApi = {
  workers: () => call<{ workers: DevelopmentWorker[] }>('/api/development-services'),
  worker: (id: string) => call<DevelopmentWorkerDetail>(`/api/development-services/workers/${encodeURIComponent(id)}`),
  open: (id: string) => post<{ url: string | null; state: 'ready' | 'pending' }>('/api/development-services/open', { id }),
  manual: (workerId: string, workspaceId: string, port: number, startPath: string) => post<{ url: string | null; state: 'ready' | 'pending' }>('/api/development-services/manual', { workerId, workspaceId, port, startPath }),
  service: (id: string) => call<{ service: { id: string; name: string; port: number; workspaceId: string; workerId: string; openable: boolean } }>(`/api/development-services/services/${encodeURIComponent(id)}`)
};
