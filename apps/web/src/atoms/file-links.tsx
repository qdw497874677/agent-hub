import { createContext, useContext } from 'react';
import type { FileTarget } from './tool-format.ts';

/**
 * 对话里工具参数的文件路径可点：专注视图提供「工作空间根 + 打开到文件页」。
 * 没有提供者（画布窗口、分叉前继承的对话）就不可点。
 */
export interface FileLinks {
  readonly root: string | null;
  readonly open: (target: FileTarget) => void;
}

export const FileLinksContext = createContext<FileLinks | null>(null);

export function useFileLinks(): FileLinks | null {
  return useContext(FileLinksContext);
}
