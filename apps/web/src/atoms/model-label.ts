/**
 * 空模型串的含义是「用运行时的默认模型」（领域侧刻意保留空串，不写成 null）。
 * 界面要显示成一句话，别在每个组件里各写一遍。
 */
export const MODEL_DEFAULT_LABEL = '默认模型';

export function modelLabel(model: string): string {
  return model.trim() === '' ? MODEL_DEFAULT_LABEL : model;
}
