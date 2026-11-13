import { parseWindowSet, type WindowSet, type WindowStore } from './canvas-windows.ts';

/** 适配器：窗口集合存在浏览器 localStorage（只是「怎么看」，不上服务端）。 */
export const localWindowStore: WindowStore = {
  load(key: string): WindowSet {
    try {
      return parseWindowSet(localStorage.getItem(key));
    } catch {
      return { windows: [] };
    }
  },
  save(key: string, set: WindowSet): void {
    try {
      if (set.windows.length === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(set));
    } catch {
      // 隐私模式写不进去：这次照样能用。
    }
  }
};
