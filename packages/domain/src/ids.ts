import { randomUUID } from 'node:crypto';

// 品牌类型：让 TaskId 与 SessionId 不能互换。`as` 只出现在本文件的窄化函数里。
export type ProjectId = string & { readonly __brand: 'ProjectId' };
export type TaskId = string & { readonly __brand: 'TaskId' };
export type SessionId = string & { readonly __brand: 'SessionId' };
export type ArtifactId = string & { readonly __brand: 'ArtifactId' };
export type AgentId = string & { readonly __brand: 'AgentId' };

/** 事件在一条会话内单调递增的位置。fork 的游标就是它。 */
export type Seq = number;

export const newProjectId = (): ProjectId => randomUUID() as ProjectId;
export const newTaskId = (): TaskId => randomUUID() as TaskId;
export const newSessionId = (): SessionId => randomUUID() as SessionId;
export const newArtifactId = (): ArtifactId => randomUUID() as ArtifactId;

export const asProjectId = (value: string): ProjectId => value as ProjectId;
export const asTaskId = (value: string): TaskId => value as TaskId;
export const asSessionId = (value: string): SessionId => value as SessionId;
export const asArtifactId = (value: string): ArtifactId => value as ArtifactId;
export const asAgentId = (value: string): AgentId => value as AgentId;
