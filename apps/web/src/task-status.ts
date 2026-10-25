import type { TaskDto } from './api.ts';

type Status = TaskDto['status'];

export const TASK_STATUS_LABEL: Record<Status, string> = {
  todo: '待开始',
  in_progress: '进行中',
  blocked: '受阻',
  in_review: '待验收',
  done: '已收尾',
  abandoned: '已放弃'
};

/** 状态徽标的配色：受阻用警示色，待验收用强调色，收尾/放弃退到背景。 */
export const TASK_STATUS_TONE: Record<Status, string> = {
  todo: 'border-hair text-tertiary',
  in_progress: 'border-sage text-sage',
  blocked: 'border-rust text-rust',
  in_review: 'border-accent text-accent',
  done: 'border-hair text-secondary',
  abandoned: 'border-hair text-tertiary'
};

/** 人在 UI 上能走的下一步（与领域状态机一致；领域仍会再校验一遍）。 */
export const NEXT_STATUS: Record<Status, readonly { label: string; next: Status }[]> = {
  todo: [
    { label: '开始', next: 'in_progress' },
    { label: '放弃', next: 'abandoned' }
  ],
  in_progress: [
    { label: '受阻', next: 'blocked' },
    { label: '待验收', next: 'in_review' },
    { label: '收尾', next: 'done' },
    { label: '放弃', next: 'abandoned' }
  ],
  blocked: [
    { label: '继续', next: 'in_progress' },
    { label: '放弃', next: 'abandoned' }
  ],
  in_review: [
    { label: '通过收尾', next: 'done' },
    { label: '打回', next: 'in_progress' },
    { label: '放弃', next: 'abandoned' }
  ],
  done: [{ label: '重开', next: 'in_progress' }],
  abandoned: [{ label: '重开', next: 'todo' }]
};
