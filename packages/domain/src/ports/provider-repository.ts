import type { ModelProvider, ProviderCheck, ProviderRouting, ProviderUsage } from '../provider.ts';

/** 模型提供商的存取。密钥单独加密存放，只有 revealKey 拿得到明文。 */
export interface ProviderRepository {
  list(): Promise<ModelProvider[]>;
  byId(id: string): Promise<ModelProvider | null>;
  bySlug(slug: string): Promise<ModelProvider | null>;
  save(provider: Omit<ModelProvider, 'hasKey'>): Promise<void>;
  remove(id: string): Promise<boolean>;
  setKey(id: string, key: string, at: number): Promise<void>;
  revealKey(id: string): Promise<string | null>;
  recordCheck(id: string, check: ProviderCheck): Promise<void>;
  /** worker 级路由覆盖：没有的不在表里。 */
  workerRouting(): Promise<Record<string, ProviderRouting>>;
  setWorkerRouting(workerId: string, routing: ProviderRouting | null): Promise<void>;
  addUsage(id: string, delta: Partial<Omit<ProviderUsage, 'lastUsedAt'>>, at: number): Promise<void>;
  usage(id: string): Promise<ProviderUsage>;
}
