import { asAgentId, capabilityMatrix } from '@agent-hub/domain';
import type { AgentDescriptor, OptionValueOrGroup, RuntimeOption } from '@agent-hub/domain';
import type { AgentDto, RuntimeOptionDto } from './wire.ts';

/**
 * domain ⇄ wire 的显式换算（子路径 `@agent-hub/contract/codec`）。
 * 不从包根导出：它要 domain 的运行时值，web 只该拿到纯 schema。
 * 形状由 drift.ts 在编译期守住，这里只做
 * 「只读 → 可变」的复制和「字符串 → 品牌 id」的还原，不再需要 `as never`。
 */
const choiceToDto = (choice: OptionValueOrGroup): RuntimeOptionDto['choices'][number] =>
  choice.kind === 'value' ? { ...choice, value: { ...choice.value } } : { ...choice, values: choice.values.map((v) => ({ ...v })) };

export function optionToDto(option: RuntimeOption): RuntimeOptionDto {
  return { ...option, choices: option.choices.map(choiceToDto) };
}

export function agentToDto(descriptor: AgentDescriptor): AgentDto {
  return {
    id: descriptor.id,
    label: descriptor.label,
    capabilities: { ...descriptor.capabilities },
    models: [...descriptor.models],
    defaultModel: descriptor.defaultModel,
    options: descriptor.options.map(optionToDto),
    ...(descriptor.providers?.length ? { providers: [...descriptor.providers] } : {})
  };
}

/** worker 报上来的 AgentDto 还原成领域描述；能力矩阵走 domain 的构造器，缺原因会被拒。 */
export function agentFromDto(dto: AgentDto): AgentDescriptor {
  return {
    id: asAgentId(dto.id),
    label: dto.label,
    capabilities: capabilityMatrix(dto.capabilities),
    models: dto.models,
    defaultModel: dto.defaultModel,
    options: dto.options,
    ...(dto.providers?.length ? { providers: dto.providers } : {})
  };
}
