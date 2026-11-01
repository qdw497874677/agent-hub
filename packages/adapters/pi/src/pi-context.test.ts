import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPiEventMapper, usageFromStats } from './map-event.ts';

test('Pi 压缩事件 → compaction（成功 / 中止 / 失败）', () => {
  const m = createPiEventMapper();
  assert.deepEqual(m.map({ type: 'compaction_start', reason: 'manual' }), [{ kind: 'compaction', phase: 'start', reason: 'manual' }]);
  assert.deepEqual(
    m.map({ type: 'compaction_end', reason: 'threshold', result: { summary: 's', firstKeptEntryId: 'a', tokensBefore: 150000, estimatedTokensAfter: 32000 }, aborted: false, willRetry: false }),
    [{ kind: 'compaction', phase: 'end', reason: 'threshold', ok: true, tokensBefore: 150000, tokensAfter: 32000, summary: 's' }]
  );
  assert.deepEqual(m.map({ type: 'compaction_end', reason: 'overflow', aborted: true }), [{ kind: 'compaction', phase: 'end', reason: 'overflow', ok: false, error: '被中止' }]);
  assert.deepEqual(m.map({ type: 'compaction_end', reason: 'weird', aborted: false, errorMessage: 'boom' }), [{ kind: 'compaction', phase: 'end', reason: 'threshold', ok: false, error: 'boom' }]);
});

test('get_session_stats → context_usage；没窗口就不报；压缩后 tokens 为 null', () => {
  assert.deepEqual(usageFromStats({ contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 } }), { kind: 'context_usage', usedTokens: 60000, windowTokens: 200000, percent: 30 });
  assert.deepEqual(usageFromStats({ contextUsage: { tokens: null, contextWindow: 200000, percent: null } }), { kind: 'context_usage', usedTokens: null, windowTokens: 200000, percent: null });
  assert.equal(usageFromStats({ tokens: {} }), null);
  assert.equal(usageFromStats(null), null);
});
