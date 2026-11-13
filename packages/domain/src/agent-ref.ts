import { invalid, type DomainError } from './errors.ts';
import { optionValues, type RuntimeOption } from './option.ts';
import { err, ok, type Result } from './result.ts';
import type { Session } from './session.ts';

/**
 * Agent 三元组：跑在哪个 runtime、用哪个模型、带哪些启动选项。
 *
 * 会话、Agent 配置（profile）、bot 都指向同一套语义，所以只留这一个形状：
 * 想换掉整套启动组合时传 `ref`，而不是三个字段各传一遍、各校验一遍。
 */
export interface AgentRef {
  readonly runtime: string;
  readonly model: string;
  readonly options: Readonly<Record<string, string | boolean>>;
}

/** 选项键：小写字母开头，后面可跟小写字母、数字、`-`、`_`、`.`。 */
export const AGENT_REF_OPTION_KEY = /^[a-z][a-z0-9_.-]{0,40}$/;
/** 一份 ref 最多带多少个启动选项。 */
export const AGENT_REF_OPTIONS_MAX = 16;
/** 单个选项值（文本）最长多少字。 */
export const AGENT_REF_OPTION_VALUE_MAX = 200;
/** 模型名最长多少字。 */
export const AGENT_REF_MODEL_MAX = 2000;

export interface AgentRefInput {
  readonly runtime: string;
  readonly model?: string;
  readonly options?: Readonly<Record<string, string | boolean>>;
}

/**
 * ref 的唯一校验入口。
 *
 * - 不给 `specs`：只做形状校验（键名、条数、值类型与长度、模型名长度）。
 * - 给 `specs`（该 agent 上报过的可调项）：再核一遍键存在、值落在候选里。
 *
 * 为什么值也要核：`acp-runtime.ts` 开跑时逐个 `changeOption`，值不合法会让会话直接失败；
 * 保存时拦住，比每条消息都新开一条 failed 会话强。清单为空时只做形状校验。
 */
export function validateAgentRef(
  input: AgentRefInput,
  specs?: readonly RuntimeOption[]
): Result<AgentRef, DomainError> {
  const runtime = (input.runtime ?? '').trim();
  if (runtime === '') return err(invalid('必须指定一个 agent'));

  const model = (input.model ?? '').trim();
  if (model.length > AGENT_REF_MODEL_MAX) return err(invalid('模型名太长了'));

  const options = input.options ?? {};
  const keys = Object.keys(options);
  if (keys.length > AGENT_REF_OPTIONS_MAX) return err(invalid(`启动选项最多 ${AGENT_REF_OPTIONS_MAX} 个`));

  const clean: Record<string, string | boolean> = {};
  for (const key of keys) {
    if (!AGENT_REF_OPTION_KEY.test(key)) {
      return err(invalid(`启动选项 ${key} 的键只能用小写字母、数字、-、_ 和 .`));
    }
    const value = options[key];
    if (typeof value === 'boolean') {
      clean[key] = value;
      continue;
    }
    if (typeof value !== 'string') return err(invalid(`启动选项 ${key} 只能是文本或开关`));
    if (value.length > AGENT_REF_OPTION_VALUE_MAX) {
      return err(invalid(`启动选项 ${key} 最多 ${AGENT_REF_OPTION_VALUE_MAX} 字`));
    }
    clean[key] = value;
  }

  if (specs && specs.length > 0) {
    for (const [id, value] of Object.entries(clean)) {
      const spec = specs.find((option) => option.id === id);
      if (!spec) return err(invalid(`agent 没有可调项 ${id}（先开一条会话，看它上报了哪些项）`));
      if (spec.kind === 'boolean') {
        if (typeof value !== 'boolean') return err(invalid(`${id} 只能是开关`));
        continue;
      }
      if (typeof value !== 'string') return err(invalid(`${id} 要选一个候选值`));
      const allowed = optionValues(spec).map((choice) => choice.value);
      if (allowed.length > 0 && !allowed.includes(value)) {
        return err(invalid(`${id} 只能是 ${allowed.slice(0, 6).join(' / ')}`));
      }
    }
  }

  return ok({ runtime, model, options: clean });
}

/** override 里给了的字段赢；`options` 浅合并（override 的同名键覆盖 base）。 */
export function mergeAgentRef(base: AgentRef, override: Partial<AgentRef>): AgentRef {
  return {
    runtime: override.runtime ?? base.runtime,
    model: override.model ?? base.model,
    options: override.options ? { ...base.options, ...override.options } : base.options
  };
}

/** 会话就是一条 ref；老数据没有 `ref` 字段，运行时仍读 `agentId`。 */
export function sessionRef(session: Pick<Session, 'agentId' | 'model' | 'options'>): AgentRef {
  return { runtime: session.agentId, model: session.model, options: session.options };
}
