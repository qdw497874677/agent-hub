import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateName, parseShimMcp, splitAggregateName } from './mcp-shim-config.ts';

test('垫片聚合：解析下发的 MCP 清单，坏条目跳过；工具名前缀可逆', () => {
  const raw = JSON.stringify([
    { transport: 'http', name: 'remote', url: 'http://127.0.0.1:1/mcp/remote' },
    { transport: 'stdio', name: 'fs', command: 'node', args: ['a.js', 3], env: { K: 'v', N: 1 } },
    { transport: 'http', name: 'Bad Name', url: 'http://x' },
    'junk'
  ]);
  assert.deepEqual(parseShimMcp(raw), [
    { transport: 'http', name: 'remote', url: 'http://127.0.0.1:1/mcp/remote' },
    { transport: 'stdio', name: 'fs', command: 'node', args: ['a.js'], env: { K: 'v' } }
  ]);
  assert.deepEqual(parseShimMcp(undefined), []);
  assert.deepEqual(parseShimMcp('{'), []);
  assert.equal(aggregateName('fs', 'read'), 'fs__read');
  assert.deepEqual(splitAggregateName('fs__read', ['fs']), { server: 'fs', tool: 'read' });
  assert.equal(splitAggregateName('read_work_log', ['fs']), null);
  assert.equal(splitAggregateName('fs__', ['fs']), null);
});
