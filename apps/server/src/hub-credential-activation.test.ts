import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setupHubCredentialBroker } from './hub-credential-activation.ts';

test('Hub 托管凭证默认尝试启用，但内嵌 Worker 时拒绝；0 显式关闭，无效值不启用', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const [mode, warning] of [
      [null, /不启动内嵌 Worker/],
      ['1', /不启动内嵌 Worker/],
      ['0', null],
      ['invalid', /仅支持 0 或 1/],
    ] as const) {
      const warnings: string[] = [];
      const config = new Map([
        ['HUB_CREDENTIAL_BROKER', mode],
        ['HUB_CREDENTIAL_ADMIN_ORIGIN', 'https://hub.example'],
        ['HUB_CREDENTIAL_GIT_ORIGINS', 'https://git.example'],
        ['HUB_CREDENTIAL_PROJECTS', 'project'],
        ['HUB_CREDENTIAL_SCRATCH_ROOT', '/not-used'],
      ]);
      const broker = await setupHubCredentialBroker({
        readEnv: (name) => config.get(name) ?? null,
        spawnWorker: '1', host: '127.0.0.1', dataDir: '/not-used', db,
        projects: { byId: async () => null }, warn: (message) => warnings.push(message),
      });
      assert.equal(broker, null);
      assert.equal(warnings.length, warning ? 1 : 0);
      if (warning) assert.match(warnings[0]!, warning);
      assert.equal(db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table').length, 0);
    }
  } finally {
    db.close();
  }
});
