import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKBENCH_SKILL_NAME,
  workbenchSkillFileByUri,
  workbenchSkillFiles,
  workbenchSkillManifest,
  workbenchSkillUri,
  workbenchSkillZip
} from './workbench-skill.ts';
import { mcpToolsFor } from './openapi/mcp.ts';

/** 只解不压缩的 zip（本仓库打包器用 store）。 */
const unzipStore = (bytes: Uint8Array): Record<string, string> => {
  const buf = Buffer.from(bytes);
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset + 4 <= buf.length && buf.toString('binary', offset, offset + 2) === 'PK') {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const flags = buf.readUInt16LE(offset + 6);
    const method = buf.readUInt16LE(offset + 8);
    const size = buf.readUInt32LE(offset + 22);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    assert.equal(method, 0, '打包应当不压缩');
    const nameStart = offset + 30;
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'binary', nameStart, nameStart + nameLen);
    const dataStart = nameStart + nameLen + extraLen;
    out[name] = buf.toString('utf8', dataStart, dataStart + size);
    offset = dataStart + size;
  }
  return out;
};

test('workbench skill：目录含 SKILL.md 与 references，清单可被 zip 还原', () => {
  const files = workbenchSkillFiles();
  const paths = files.map((file) => file.path);
  assert.ok(paths.includes('SKILL.md'));
  assert.ok(paths.includes('references/tools.md'));
  assert.ok(paths.includes('references/workflows.md'));
  assert.ok(paths.includes('references/errors.md'));
  const manifest = workbenchSkillManifest();
  assert.equal(manifest.name, WORKBENCH_SKILL_NAME);
  assert.match(manifest.description, /MCP/);
  const unpacked = unzipStore(workbenchSkillZip());
  assert.deepEqual(Object.keys(unpacked).sort(), paths.map((path) => `${WORKBENCH_SKILL_NAME}/${path}`).sort());
  assert.equal(unpacked[`${WORKBENCH_SKILL_NAME}/SKILL.md`], files.find((file) => file.path === 'SKILL.md')!.text);
});

test('workbench skill：按 uri 读文件；未知 uri 为空', () => {
  const found = workbenchSkillFileByUri(workbenchSkillUri('SKILL.md'));
  assert.ok(found);
  assert.match(found.text, /session_start/);
  assert.equal(workbenchSkillFileByUri('skill://other/SKILL.md'), undefined);
  assert.equal(workbenchSkillFileByUri(workbenchSkillUri('../secret')), undefined);
});

test('workbench skill：清单 / zip / 源文件与已注册 MCP 工具一致，含提供商管理', () => {
  const tools = mcpToolsFor(undefined, { writes: true });
  const files = Object.fromEntries(workbenchSkillFiles().map((file) => [file.path, file.text]));
  const skill = files['SKILL.md'] ?? '';
  const list = files['references/tools.md'] ?? '';
  const workflows = files['references/workflows.md'] ?? '';
  assert.match(skill, /providers:manage/);
  assert.match(skill, /不能给只限项目的令牌/);
  assert.match(workflows, /## 8\. 配置模型提供商（要 `providers:manage`）/);
  assert.match(workflows, /provider_delete \{ providerId, confirm: true/);
  assert.match(workflows, /provider_routing_set/);
  const readOnly = tools.filter((tool) => tool.readOnly).length;
  assert.match(list, new RegExp(`当前 ${tools.length} 个：只读 ${readOnly}，写 ${tools.length - readOnly}。`));
  const missing = tools.filter((tool) => !list.includes('`' + tool.name + '`')).map((tool) => tool.name);
  assert.deepEqual(missing, [], 'tools.md 缺工具，跑 npm run skill:tools');
  for (const tool of tools) {
    const row = list.split('\n').find((line) => line.includes('`' + tool.name + '`'));
    assert.ok(row, tool.name);
    const kind = tool.readOnly ? '| 读 |' : '| 写 |';
    assert.ok(row.includes(kind), `${tool.name} 的读/写标注不对：${row}`);
  }
  for (const name of ['provider_list', 'provider_create', 'provider_update', 'provider_set_key', 'provider_probe', 'provider_test', 'provider_delete', 'provider_routing_set']) {
    assert.ok(list.includes('`' + name + '`'), name);
  }
  assert.match(list, /`provider_list` \| 读 \| `provider\.read`/);
  assert.match(list, /`provider_delete` \| 写 \| `provider\.manage`/);
  const unpacked = unzipStore(workbenchSkillZip());
  const prefix = `${WORKBENCH_SKILL_NAME}/`;
  assert.equal(unpacked[`${prefix}references/tools.md`], list);
  assert.equal(unpacked[`${prefix}SKILL.md`], skill);
  assert.equal(unpacked[`${prefix}references/workflows.md`], workflows);
  const manifest = workbenchSkillManifest();
  const byPath = Object.fromEntries(manifest.files.map((file) => [file.path, file.content]));
  assert.equal(byPath['references/tools.md'], list);
  assert.equal(byPath['SKILL.md'], skill);
});
