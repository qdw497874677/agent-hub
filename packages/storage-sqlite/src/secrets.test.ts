import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretVault, loadSecretKey } from './secrets.ts';

test('密钥保险箱：落库是密文；换主密钥或挪名字都解不开', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-secrets-'));
  try {
    const keyFile = join(dir, 'secret.key');
    const key = await loadSecretKey({ file: keyFile });
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.deepEqual(await loadSecretKey({ file: keyFile }), key);
    const path = join(dir, 'hub.db');
    const db = new DatabaseSync(path);
    const vault = createSecretVault(db, key);
    await vault.put('GH_TOKEN', 'plain-secret-value', 5);
    assert.deepEqual(await vault.list(), [{ name: 'GH_TOKEN', updatedAt: 5 }]);
    assert.deepEqual(await vault.reveal(['GH_TOKEN', 'NOPE']), { GH_TOKEN: 'plain-secret-value' });
    db.close();
    assert.doesNotMatch(readFileSync(path).toString('latin1'), /plain-secret-value/);

    const other = createSecretVault(new DatabaseSync(path), Buffer.alloc(32, 7));
    assert.deepEqual(await other.reveal(['GH_TOKEN']), {});
    const moved = new DatabaseSync(path);
    moved.exec("UPDATE asset_secrets SET name = 'OTHER' WHERE name = 'GH_TOKEN'");
    assert.deepEqual(await createSecretVault(moved, key).reveal(['OTHER']), {});
    assert.equal(await createSecretVault(moved, key).remove('OTHER'), true);
    assert.equal(await createSecretVault(moved, key).remove('OTHER'), false);
    moved.close();

    await assert.rejects(loadSecretKey({ env: 'c2hvcnQ=', file: keyFile }), /32 字节/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
