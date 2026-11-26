import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewAnchor, reviewRangeValid, type ReviewScope } from './review-anchor.ts';

const scope: ReviewScope = { sourceSessionId: 's1', member: null, path: 'a.ts', base: 'head', turn: null, commit: 'abc', target: null, branch: null, scopeKey: 'workspace-a' };
const diff = { path: 'a.ts', binary: false, truncated: false, patch: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n same\n-old\n+new\n@@ -5 +5 @@\n-old5\n+new5\n' };

test('versions are scoped to comparison and patch, and ranges remain inside one hunk', () => {
  const anchor = reviewAnchor(scope, diff)!;
  assert.ok(anchor);
  assert.equal(reviewRangeValid(anchor, 'old', 1, 2), true);
  assert.equal(reviewRangeValid(anchor, 'new', 5, 5), true);
  assert.equal(reviewRangeValid(anchor, 'new', 2, 5), false);
  assert.equal(reviewRangeValid(anchor, 'old', 0, 1), false);
  assert.equal(reviewRangeValid(anchor, 'old', 1, 1.5), false);
  assert.notEqual(anchor.version, reviewAnchor({ ...scope, member: 'ws2' }, diff)?.version);
  assert.notEqual(anchor.version, reviewAnchor({ ...scope, target: 'def' }, diff)?.version);
  assert.notEqual(anchor.version, reviewAnchor({ ...scope, scopeKey: 'workspace-b' }, diff)?.version);
  assert.notEqual(anchor.version, reviewAnchor(scope, { ...diff, patch: diff.patch.replace('+new\n', '+changed\n') })?.version);
});

test('reject non-addressable, incomplete and malformed patches and unresolved turns', () => {
  for (const bad of [
    { ...diff, binary: true }, { ...diff, truncated: true }, { ...diff, path: 'other' },
    { ...diff, patch: '' }, { ...diff, patch: diff.patch.replace('+new\n', '') },
    { ...diff, patch: diff.patch.replace('@@ -5 +5 @@', '@@@ -5 +5 @@@') }
  ]) assert.equal(reviewAnchor(scope, bad), null);
  assert.equal(reviewAnchor({ ...scope, base: 'turn' }, diff), null);
  assert.ok(reviewAnchor({ ...scope, base: 'turn', turn: 4 }, diff));
  const added = reviewAnchor(scope, { ...diff, patch: '@@ -0,0 +1 @@\n+new\n' })!;
  assert.equal(reviewRangeValid(added, 'old', 1, 1), false);
  assert.equal(reviewRangeValid(added, 'new', 1, 1), true);
});
