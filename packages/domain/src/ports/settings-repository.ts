import type { HubSettings } from '../account.ts';

export interface SettingsRepository {
  /** 没存过就是 DEFAULT_SETTINGS。 */
  get(): Promise<HubSettings>;
  save(settings: HubSettings): Promise<void>;
}
