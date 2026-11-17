/**
 * 侧栏 / 机器面板用的线性图标（路径取自 lucide，ISC 许可）。
 * 统一 16px、1.75 线宽、currentColor：同一处不再混用 ⌂ ⚙ ▦ 这类字符图标。
 */
import type { ReactNode } from 'react';

export type IconName =
  | 'home'
  | 'chat'
  | 'bot'
  | 'brain'
  | 'folder'
  | 'package'
  | 'activity'
  | 'shield'
  | 'plus'
  | 'search'
  | 'settings'
  | 'panel'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'x'
  | 'grid'
  | 'list'
  | 'message'
  | 'server';

const PATHS: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
    </>
  ),
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  bot: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 8V4M8 4h8M9 13v2M15 13v2" />
    </>
  ),
  brain: (
    <>
      <path d="M9.5 3a3 3 0 0 0-3 3v.2A3 3 0 0 0 4 9.5a3 3 0 0 0 .8 2A3 3 0 0 0 5 17a3 3 0 0 0 4.5 2.6V3.6A3 3 0 0 0 9.5 3Z" />
      <path d="M14.5 3a3 3 0 0 1 3 3v.2A3 3 0 0 1 20 9.5a3 3 0 0 1-.8 2A3 3 0 0 1 19 17a3 3 0 0 1-4.5 2.6V3.6a3 3 0 0 1 0-.6Z" />
    </>
  ),
  folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />,
  package: (
    <>
      <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </>
  ),
  activity: <path d="M3 12h4l3 8 4-16 3 8h4" />,
  shield: <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  'chevron-left': <path d="m15 6-6 6 6 6" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  message: <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z" />,
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  )
};

export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 ${className}`}
    >
      {PATHS[name]}
    </svg>
  );
}
