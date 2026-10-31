import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { CatalogComponent } from '@agent-hub/domain';
import { createSqliteComponents } from './components.ts';

const item = (version: string, status: CatalogComponent['status'] = 'pending'): CatalogComponent => ({
  id: 'demo', runtime: 'pi', packageName: 'demo-pi-ext', version, resolved: 'https://r/x.tgz', integrity: 'sha512-x', provides: [{ capability: 'tool:demo' }],
  scripts: { postinstall: 'node x.js' }, dependencyCount: 1, status, submittedBy: 'd@b.co', submittedAt: 1, reviewedBy: null, reviewedAt: null, reviewNote: null
});

test('组件目录：按 id@version 存取、覆盖；重开库还在', async () => {
  const db = new DatabaseSync(':memory:');
  const { catalog } = createSqliteComponents(db);
  await catalog.save(item('1.0.0'));
  await catalog.save(item('1.1.0'));
  await catalog.save({ ...item('1.0.0'), status: 'approved', reviewedBy: 'd@b.co' });
  assert.equal((await catalog.byId('demo@1.0.0'))?.status, 'approved');
  assert.equal(await catalog.byId('demo@9.9.9'), null);
  const again = createSqliteComponents(db);
  assert.deepEqual((await again.catalog.list()).map((c) => c.version), ['1.0.0', '1.1.0']);
});

test('钉住：每台机器每个组件一行，覆盖、删除互不影响', () => {
  const { pins } = createSqliteComponents(new DatabaseSync(':memory:'));
  const pin = { workerId: 'w1', componentId: 'demo', runtime: 'pi', version: '1.0.0', integrity: 'sha512-x', installedBy: 'm@b.co', installedAt: 1 };
  pins.upsert(pin);
  pins.upsert({ ...pin, workerId: 'w2' });
  pins.upsert({ ...pin, version: '1.1.0', installedAt: 2 });
  assert.deepEqual(pins.pinsFor('w1').map((p) => p.version), ['1.1.0']);
  pins.remove('w1', 'demo', 'pi');
  assert.deepEqual(pins.pinsFor('w1'), []);
  assert.equal(pins.pinsFor('w2').length, 1);
});
