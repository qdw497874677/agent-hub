import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStartOptions } from './pi-runtime.ts';
import type { DomainError, Result, RuntimeOption } from '@agent-hub/domain';

const session = (failOn: string | null) => {
  const seen: string[] = [];
  return {
    seen,
    changeOption: async (id: string, value: string | boolean): Promise<Result<readonly RuntimeOption[], DomainError>> => {
      seen.push(`${id}=${String(value)}`);
      if (id === failOn) return { ok: false, error: { code: 'unavailable', message: `bad ${id}` } as DomainError };
      return { ok: true, value: [] };
    }
  };
};

test('bot 启动选项：除 model 外逐项落到 Pi 上', async () => {
  const fake = session(null);
  const applied = await applyStartOptions(fake, { model: 'p/m', thinking: 'low' });
  assert.equal(applied.ok, true);
  assert.deepEqual(fake.seen, ['thinking=low'], 'model 已由 --model 传过，不再走 changeOption');
});

test('bot 启动选项：空字符串跳过，非法值让启动失败', async () => {
  const empty = session(null);
  assert.equal((await applyStartOptions(empty, { thinking: '' })).ok, true);
  assert.deepEqual(empty.seen, []);

  const bad = session('thinking');
  const failed = await applyStartOptions(bad, { thinking: 'nope' });
  assert.equal(failed.ok, false);
});
