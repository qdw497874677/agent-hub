/**
 * 能力矩阵：三态 + 原因。UI 按它渲染，不按 agent 名字渲染（定位 §7 第 3 条）。
 * `limited` / `denied` 必须有 reason，否则用户看到置灰却不知道为什么。
 */
export type CapabilityState = 'available' | 'limited' | 'denied';

export interface Capability {
  readonly state: CapabilityState;
  readonly reason?: string;
}

export type CapabilityName =
  | 'prompt'
  | 'interrupt'
  | 'fork'
  | 'resume'
  | 'tool_calls'
  | 'artifacts'
  | 'structured_events';

export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  'prompt',
  'interrupt',
  'fork',
  'resume',
  'tool_calls',
  'artifacts',
  'structured_events'
];

export const CAPABILITY_LABELS: Readonly<Record<CapabilityName, string>> = {
  prompt: '发送消息',
  interrupt: '中断运行',
  fork: '会话分叉',
  resume: '崩溃后继续',
  tool_calls: '工具调用可见',
  artifacts: '产出物归档',
  structured_events: '结构化事件'
};

export type CapabilityMatrix = Readonly<Record<CapabilityName, Capability>>;

export const available: Capability = { state: 'available' };

export function limited(reason: string): Capability {
  return { state: 'limited', reason };
}

export function denied(reason: string): Capability {
  return { state: 'denied', reason };
}

/** 构造矩阵时校验原因必填。缺原因是编码错误，不是用户输入错误，所以直接抛。 */
export function capabilityMatrix(raw: Record<CapabilityName, Capability>): CapabilityMatrix {
  for (const name of CAPABILITY_NAMES) {
    const cap = raw[name];
    if (!cap) throw new Error(`能力矩阵缺项：${name}`);
    if (cap.state !== 'available' && !cap.reason?.trim()) {
      throw new Error(`能力矩阵 ${name} 为 ${cap.state}，必须给出 reason`);
    }
  }
  return Object.freeze({ ...raw });
}

export function allowsFor(matrix: CapabilityMatrix, name: CapabilityName): boolean {
  return matrix[name].state !== 'denied';
}

/** UI 显示不可用原因时只调这一个函数，不自己判断 agent 是谁。 */
export function unavailableReason(matrix: CapabilityMatrix, name: CapabilityName): string | null {
  const cap = matrix[name];
  return cap.state === 'available' ? null : (cap.reason ?? null);
}
