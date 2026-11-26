import { createHash } from 'node:crypto';

/** Compare coordinates must come from the same authoritative lookup as the patch.
 * For a turn comparison, resolve "latest" to its explicit turn before calling. */
export interface ReviewScope {
  sourceSessionId: string;
  member: string | null;
  path: string;
  base: 'session' | 'head' | 'turn' | 'branch';
  turn: number | null;
  commit: string | null;
  target: string | null;
  branch: string | null;
  scopeKey: string;
}

export interface ReviewPatch {
  path: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
}

interface HunkRange { oldStart: number; oldEnd: number; newStart: number; newEnd: number }
export interface ReviewAnchor { version: string; hunks: readonly HunkRange[] }

/** Only call with the single-file, sensitive-path-filtered workspace-files diff. */
export function reviewAnchor(scope: ReviewScope, diff: ReviewPatch): ReviewAnchor | null {
  if (diff.binary || diff.truncated || diff.path !== scope.path || !diff.patch || Buffer.byteLength(diff.patch) > 2 * 1024 * 1024) return null;
  if (scope.base === 'turn' ? !Number.isSafeInteger(scope.turn) || scope.turn! < 0 : scope.turn !== null) return null;
  const lines = diff.patch.split('\n');
  const hunks: HunkRange[] = [];
  let active: { oldStart: number; newStart: number; oldCount: number; newCount: number; oldSeen: number; newSeen: number } | null = null;
  const finish = () => {
    if (!active) return true;
    if (active.oldCount !== active.oldSeen || active.newCount !== active.newSeen) return false;
    hunks.push({ oldStart: active.oldStart, oldEnd: active.oldStart + active.oldCount - 1, newStart: active.newStart, newEnd: active.newStart + active.newCount - 1 });
    active = null;
    return true;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      if (!finish()) return null;
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
      if (!match) return null;
      const [oldStart, oldCount, newStart, newCount] = [Number(match[1]), Number(match[2] ?? 1), Number(match[3]), Number(match[4] ?? 1)];
      if (![oldStart, oldCount, newStart, newCount, oldStart + oldCount, newStart + newCount].every(Number.isSafeInteger) || (oldCount > 0 && oldStart < 1) || (newCount > 0 && newStart < 1)) return null;
      active = { oldStart, newStart, oldCount, newCount, oldSeen: 0, newSeen: 0 };
      continue;
    }
    if (!active) continue;
    if (line === '\\ No newline at end of file') continue;
    if (i === lines.length - 1 && line === '') continue;
    const prefix = line[0];
    if (prefix === ' ' || prefix === '-') active.oldSeen++;
    if (prefix === ' ' || prefix === '+') active.newSeen++;
    if (prefix !== ' ' && prefix !== '-' && prefix !== '+') return null;
    if (active.oldSeen > active.oldCount || active.newSeen > active.newCount) return null;
  }
  if (!finish() || hunks.length === 0) return null;
  const version = createHash('sha256').update(JSON.stringify([
    'review-anchor-v1', scope.sourceSessionId, scope.member, scope.path, scope.base,
    scope.turn, scope.commit, scope.target, scope.branch, scope.scopeKey, diff.patch
  ])).digest('hex');
  return { version, hunks };
}

/** A selection must fit entirely within one hunk and one side. */
export function reviewRangeValid(anchor: ReviewAnchor, side: 'old' | 'new', start: number, end: number): boolean {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return false;
  return anchor.hunks.some((hunk) => side === 'old'
    ? start >= hunk.oldStart && end <= hunk.oldEnd
    : start >= hunk.newStart && end <= hunk.newEnd);
}
