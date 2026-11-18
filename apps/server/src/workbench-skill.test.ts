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
