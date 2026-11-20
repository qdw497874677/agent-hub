/**
 * Web API 客户端（barrel）。
 *
 * 原来这一个 1400 行的文件按 surface 拆成 `./api/*`：每个模块管自己的 DTO 与命名空间，
 * 这里只把它们原样转出，所以既有调用方（`import { sessionsApi } from '.../shell/api.ts'`）
 * 一行都不用改。新增接口请加到对应的 surface 模块，不要再往这里堆。
 */
export { RequestFailed, UNAUTHORIZED_EVENT, streamUrl } from './api/http.ts';
export type { ApiError } from './api/http.ts';

export * from './api/sessions.ts';
export * from './api/files.ts';
export * from './api/messages.ts';
export * from './api/tasks.ts';
export * from './api/projects.ts';
export * from './api/workspaces.ts';
export * from './api/assets.ts';
export * from './api/providers.ts';
export * from './api/workers.ts';
export * from './api/tokens.ts';
export * from './api/account.ts';
export * from './api/git.ts';
export * from './api/memory.ts';
export * from './api/misc.ts';
export * from './api/hub.ts';
