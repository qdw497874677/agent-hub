import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';
import type { ToolGrant, ToolScope } from '../tool.ts';

/** JSON Schema（给模型看的参数说明）；domain 不认识校验库，只当数据传。 */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolDescriptor {
  /** 规范名：`域.动作`，如 `task.log.append`。传输适配器可以另给别名。 */
  readonly name: string;
  /** 破坏性变更 +1。 */
  readonly version: number;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly scope: ToolScope;
  /** 每个授权每分钟最多几次；不填用网关默认。 */
  readonly perMinute?: number;
}

export interface ToolContext {
  readonly grant: ToolGrant;
  readonly now: number;
}

/** 工具插件：一个 provider 一组工具。传输（MCP / stdio shim / REST）都只是它的适配器。 */
export interface ToolProvider {
  readonly id: string;
  tools(): readonly ToolDescriptor[];
  call(name: string, input: unknown, ctx: ToolContext): Promise<Result<unknown, DomainError>>;
}
