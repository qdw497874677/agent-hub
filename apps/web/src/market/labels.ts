import type { AssetScopeDto } from './types.ts';
import type { AssetKindDto } from '../api.ts';

export const SCOPE_TEXT: Record<AssetScopeDto, string> = { personal: '个人', team: '团队', project: '项目', global: '全局' };
export const KIND_TEXT: Record<AssetKindDto, string> = { skill: '技能', instruction: '指令', mcp: 'MCP' };
export const STATUS_TEXT: Record<string, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回',
  changes_requested: '要求修改',
  withdrawn: '已撤回',
  superseded: '被新版本取代'
};
