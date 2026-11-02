import type { GitText, GitTextInput } from './ports/pull-requests.ts';

/** ADR 0027 §2 的纯规则：远端解析、模板文案、分支名。 */

/** github.com 的 https / ssh 地址 → owner/name；别的平台 null。 */
export function githubRepoOf(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** 没 token、没 gh 时给人点的「在 GitHub 上新建 PR」。 */
export function compareUrl(repo: string, base: string, head: string): string {
  return `https://github.com/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`;
}

const STATUS_WORD: Record<string, string> = { added: '新增', untracked: '新增', modified: '修改', deleted: '删除', renamed: '重命名' };

/** 规则版模板（D4 回落）：标题 = 任务名；正文列文件和工作日志摘要。 */
export function templateGitText(input: Pick<GitTextInput, 'taskTitle' | 'files' | 'workLog'>): GitText {
  const title = clip(input.taskTitle.replace(/\s+/g, ' ').trim() || '更新', 72);
  const lines = input.files.slice(0, 30).map((f) => `- ${STATUS_WORD[f.status] ?? f.status} ${f.path}`);
  if (input.files.length > 30) lines.push(`- …另外 ${input.files.length - 30} 个文件`);
  const log = input.workLog.trim();
  const body = ['## 做了什么', ...(lines.length ? lines : ['- （没有文件改动）']), ...(log ? ['', '## 工作日志', clip(log, 1500)] : []), '', '_由 agent-hub 生成_'].join('\n');
  return { message: `${title}\n\n${lines.join('\n')}`.trim(), title, body, branch: null };
}

/** 模型给的分支名清洗：只留 feat|fix|chore|docs|refactor|test/<kebab>，不合格 null。 */
export function cleanBranchName(raw: string | null | undefined, prefix = ''): string | null {
  if (!raw) return null;
  const m = /^(feat|fix|chore|docs|refactor|test|perf)\/([a-z0-9][a-z0-9-]{1,48}[a-z0-9])$/.exec(raw.trim().toLowerCase());
  return m ? `${prefix}${m[1]}/${m[2]}` : null;
}

/** 模型文本 → GitText：只认 JSON {message,title,body,branch}；缺字段 null。 */
export function parseGitText(text: string): GitText | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
    if (!s('message') || !s('title')) return null;
    return { message: clip(s('message'), 4000), title: clip(s('title').split('\n')[0]!, 120), body: clip(s('body') || s('message'), 8000), branch: cleanBranchName(s('branch')) };
  } catch {
    return null;
  }
}

export const GIT_LIMITS = { patchBytes: 64 * 1024, messageChars: 4000, titleChars: 120, bodyChars: 20_000, syncEveryMs: 10 * 60_000 } as const;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
