/**
 * diff 里选一段代码、变成一句 `@path:start-end` 引用（docs/design/interaction-borrowing.md §4）。
 *
 * 这里只放不碰 DOM 的规则：patch 怎么拆行、两次点击怎么成段、引用串怎么写。
 * 渲染和点击在 `files-browser.tsx` 的 DiffView 里；把草稿怎么接在 `focus.tsx` 里。
 * 纯函数才好测——行号错一位，人拿到的引用就指到别的地方去了。
 */

export type DiffLineKind = 'meta' | 'hunk' | 'added' | 'removed' | 'context';

export type DiffRow = {
  readonly kind: DiffLineKind;
  /** 去掉行首标记（`+` / `-` / 空格）之后的正文；hunk 和 meta 行原样保留。 */
  readonly text: string;
  /** 老文件里的行号：removed / context 才有。 */
  readonly oldLine?: number;
  /** 新文件里的行号：added / context 才有。 */
  readonly newLine?: number;
  /** hunk 头里 `@@ … @@` 之后那半句（通常是函数名），别的行没有。 */
  readonly heading?: string;
};

/** 引用落在文件的哪一边：删掉的行只能按老文件算，加进来的行只能按新文件算。 */
export type DiffSide = 'old' | 'new';

/**
 * 一次选择。第一次点行号只定锚点（`end` 还没定），第二次点同一个侧面的行号补成段，
 * 第三次重新从这一行开始。跨侧的点击不算数——老文件的行号和新文件的行号没有同一个坐标系。
 */
export type LineSelection = {
  readonly side: DiffSide;
  readonly anchor: number;
  readonly end?: number;
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** `--- a/x` / `+++ b/x` 只有在 hunk 外面才是文件头；hunk 里面它们就是删掉 / 加进来的代码行。 */
const FILE_HEADER = /^(index |--- |\+\+\+ |new file |deleted file |old mode |new mode |similarity index |rename from |rename to |copy from |copy to |Binary files )/;

/**
 * 把 unified diff 拆成一行一条。行号按 hunk 头里的起点往后数，
 * 所以渲染出来的数字和 `git diff` 里看到的一致，也就能被引用。
 *
 * hunk 头里的行数就是 hunk 的边界：数完了就算出去，后面出现的 `--- a/x` 才是文件头。
 * 这样「删掉一行 `-- x`」不会被误认成文件头（那一行的原文是 `--- x`）。
 */
export function parsePatchLines(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let inHunk = false;
  const done = (): void => {
    if (oldLeft <= 0 && newLeft <= 0) inHunk = false;
  };
  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') {
      // 补丁末尾的换行、文件之间的空行：不落行，也别把 hunk 状态带过去
      inHunk = false;
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      inHunk = true;
      const heading = (hunk[5] ?? '').trim();
      rows.push(heading === '' ? { kind: 'hunk', text: line } : { kind: 'hunk', text: line, heading });
      continue;
    }
    if (line.startsWith('\\')) {
      // `\ No newline at end of file`：注释，不是代码，也不占行号
      rows.push({ kind: 'meta', text: line });
      continue;
    }
    if (!inHunk && (line.startsWith('diff ') || FILE_HEADER.test(line))) {
      rows.push({ kind: 'meta', text: line });
      continue;
    }
    if (inHunk) {
      if (line.startsWith('+')) {
        rows.push({ kind: 'added', text: line.slice(1), newLine });
        newLine++;
        newLeft--;
        done();
        continue;
      }
      if (line.startsWith('-')) {
        rows.push({ kind: 'removed', text: line.slice(1), oldLine });
        oldLine++;
        oldLeft--;
        done();
        continue;
      }
      if (line.startsWith(' ')) {
        rows.push({ kind: 'context', text: line.slice(1), oldLine, newLine });
        oldLine++;
        newLine++;
        oldLeft--;
        newLeft--;
        done();
        continue;
      }
      // hunk 里出现认不出的行：当元信息显示，不猜行号，后面的计数也不再当真
      inHunk = false;
    }
    rows.push({ kind: 'meta', text: line });
  }
  return rows;
}

/** 引用里的路径是相对工作空间根的：去掉前导 `./`，反斜杠统一成正斜杠。 */
export function normalizeRefPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/{2,}/g, '/');
}

/** 选中范围，起止已经排好序（反向选也成立）。 */
export function selectionRange(selection: LineSelection | null | undefined): { start: number; end: number } | null {
  if (!selection) return null;
  const end = selection.end ?? selection.anchor;
  return { start: Math.min(selection.anchor, end), end: Math.max(selection.anchor, end) };
}

/**
 * 点一行：没有选择就从这里开始；同侧再点一次补成段；段已经有了就重新开始。
 * 换到另一侧不接——两边行号对不上，接了就是错引用。
 */
export function toggleLine(selection: LineSelection | null, side: DiffSide, line: number): LineSelection | null {
  if (!Number.isInteger(line) || line < 1) return selection;
  if (!selection) return { side, anchor: line };
  if (selection.side !== side) return selection;
  if (selection.end === undefined) return { side, anchor: selection.anchor, end: line };
  return { side, anchor: line };
}

/** 这一行在不在选中的段里（渲染高亮用）。 */
export function inSelection(selection: LineSelection | null, side: DiffSide, line: number): boolean {
  const range = selectionRange(selection);
  if (!selection || !range || selection.side !== side) return false;
  return line >= range.start && line <= range.end;
}

/** `src/a.ts:12` / `src/a.ts:12-20`；没有选择或路径为空就给 null。 */
export function selectionRef(filePath: string, selection: LineSelection | null | undefined): string | null {
  const range = selectionRange(selection);
  const path = normalizeRefPath(filePath);
  if (!range || path === '') return null;
  return range.start === range.end ? `${path}:${range.start}` : `${path}:${range.start}-${range.end}`;
}

/**
 * 把引用接到草稿末尾：原来的字一个不动，`@` 前面和末尾各留一个空格，
 * 和手打 `@path` 是同一种语法（composer 的补全认得它）。
 */
export function appendRef(draft: string, ref: string): string {
  const line = ref.startsWith('@') ? ref : `@${ref}`;
  const base = draft.replace(/\s+$/, '');
  return base === '' ? `${line} ` : `${base} ${line} `;
}
