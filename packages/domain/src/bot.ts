import type { AgentRef } from './agent-ref.ts';
import type { ProjectId } from './ids.ts';
import type { RoleReuse } from './messaging.ts';

/** bot 的 id：`bot_<16 hex>`，由创建方按 seed 算出来（域内不读时钟、不用 node:crypto）。 */
export type BotId = string;

/**
 * 一个 bot 的定义（不含身份与时间戳）。
 *
 * 地址、群成员、spawn 记录、连接器都按 `name` 引用；整表保存与从旧 roles JSON 读出来的
 * 都是这个形状，落库前再由用例补上 id / projectId / 时间戳。
 */
export interface BotDefinition {
  /** @id：建好不改（地址、群成员、spawn 记录、连接器都按它引用）。 */
  readonly name: string;
  /**
   * runtime + model + 启动选项（如 `thought_level: 'medium'`）。建会话时垫进去；
   * 会话创建后仍可在会话里覆盖，这里的值只是默认值——与会话的 `options` 是同一套 key。
   */
  readonly ref: AgentRef;
  readonly displayName?: string;
  readonly color?: string;
  /** 职责说明，作为它在群里的系统提示（最多 PERSISTENT_AGENT_DESCRIPTION_MAX 字）。 */
  readonly description: string;
  /** sticky：项目里一直复用同一个；per-trace：同一条协作链复用；always-new：每次都新开。 */
  readonly reuse: RoleReuse;
}

/**
 * 一等 bot：项目里常驻的 AI 成员（历史上一部分存储在 agent 消息配置的 `roles` 里，
 * 界面上一直叫「bot」）。C3a 起按项目存进 `bots` 表。
 */
export interface Bot extends BotDefinition {
  readonly id: BotId;
  readonly projectId: ProjectId;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** @deprecated 老名字，等价于 `Bot`；新代码用 `Bot`。 */
export type PersistentAgent = Bot;

/**
 * 由 seed 算稳定的 bot id：两轮 FNV-1a 拼成 16 位 hex（纯 JS，不依赖宿主）。
 *
 * - seed 一律是 `projectId + '\0' + name`：创建、迁移、回落旧 roles JSON 三处算出同一个 id，
 *   所以「删了同名 bot 再建」会复用原 id——引用都按 name 寻址，这不影响正确性，反而让历史引用继续指得通。
 */
export function botIdFrom(seed: string): BotId {
  const digest = (offset: number): string => {
    let hash = offset >>> 0;
    for (let index = 0; index < seed.length; index += 1) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };
  return `bot_${digest(0x811c9dc5)}${digest(0x9e3779b9)}`;
}
