
// 品牌类型：让 TaskId 与 SessionId 不能互换。`as` 只出现在本文件的窄化函数里。
export type ProjectId = string & { readonly __brand: 'ProjectId' };
export type TaskId = string & { readonly __brand: 'TaskId' };
export type SessionId = string & { readonly __brand: 'SessionId' };
export type ArtifactId = string & { readonly __brand: 'ArtifactId' };
export type AgentId = string & { readonly __brand: 'AgentId' };

/** 事件在一条会话内单调递增的位置。fork 的游标就是它。 */
export type Seq = number;

/**
 * 唯一的随机 id 来源。用 Web Crypto（Node、浏览器、Workers 都有），
 * 领域层因此不依赖任何 `node:` 模块；要可预测的 id 时在测试里替换 globalThis.crypto 即可。
 */
export const newId = (): string => globalThis.crypto.randomUUID();

export const newProjectId = (): ProjectId => newId() as ProjectId;
export const newTaskId = (): TaskId => newId() as TaskId;
export const newSessionId = (): SessionId => newId() as SessionId;
export const newArtifactId = (): ArtifactId => newId() as ArtifactId;

export const asProjectId = (value: string): ProjectId => value as ProjectId;
export const asTaskId = (value: string): TaskId => value as TaskId;
export const asSessionId = (value: string): SessionId => value as SessionId;
export const asArtifactId = (value: string): ArtifactId => value as ArtifactId;
export const asAgentId = (value: string): AgentId => value as AgentId;
export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' };
export const newWorkspaceId = (): WorkspaceId => newId() as WorkspaceId;
export const asWorkspaceId = (value: string): WorkspaceId => value as WorkspaceId;
