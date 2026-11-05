import type { ConnectorBinding, TriggerRun } from '../connector.ts';

/** connector_binding / trigger_run 的持久化。 */
export interface ConnectorStore {
  saveBinding(b: ConnectorBinding): Promise<void>;
  binding(id: string): Promise<ConnectorBinding | null>;
  bindingsOf(agentProjectId: string, agentName: string): Promise<ConnectorBinding[]>;
  bindingsFor(connector: string): Promise<ConnectorBinding[]>;
  allBindings(): Promise<ConnectorBinding[]>;
  deleteBinding(id: string): Promise<void>;
  /** CAS：next_run_at 还是 expected 才改。 */
  advance(id: string, expected: number | null, next: number, now: number): Promise<boolean>;
  /** 插入一条运行记录；同 binding + externalId 已有就返回 false（去重）。 */
  insertRun(r: TriggerRun): Promise<boolean>;
  hasRun(bindingId: string, externalId: string): Promise<boolean>;
  saveRun(r: TriggerRun): Promise<void>;
  runs(bindingId: string, limit: number): Promise<TriggerRun[]>;
  openRuns(bindingId: string): Promise<TriggerRun[]>;
  waitingRuns(): Promise<TriggerRun[]>;
  deliveredRuns(): Promise<TriggerRun[]>;
  deliveredRunFor(sessionId: string): Promise<TriggerRun | null>;
  /** 智能体关联的项目（默认项目 = 定义它的项目，不在表里）。 */
  agentProjects(agentProjectId: string, agentName: string): Promise<string[]>;
  setAgentProjects(agentProjectId: string, agentName: string, projectIds: readonly string[]): Promise<void>;
}
