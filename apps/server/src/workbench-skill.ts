/**
 * 打包并读取仓库里的 agent-hub-workbench skill（给外部 agent 下载）。
 * 文件来自源树 skills/agent-hub-workbench/，与 MCP resources/list、GET /openapi/v1/skills/agent-hub-workbench 共用。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

export const WORKBENCH_SKILL_NAME = 'agent-hub-workbench';
export const WORKBENCH_SKILL_URI_PREFIX = `skill://${WORKBENCH_SKILL_NAME}/`;

export interface WorkbenchSkillFile {
  /** 相对 skill 根目录，POSIX 分隔符，例如 `SKILL.md`、`references/tools.md`。 */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly text: string;
}

export const workbenchSkillDir = (): string =>
  fileURLToPath(new URL('../../../skills/agent-hub-workbench', import.meta.url));

const walk = (root: string, dir: string, out: WorkbenchSkillFile[]): void => {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      walk(root, full, out);
      continue;
    }
    if (!name.endsWith('.md')) continue;
    const bytes = readFileSync(full);
    out.push({
      path: relative(root, full).split(sep).join('/'),
      bytes,
      text: bytes.toString('utf8')
    });
  }
};

export function workbenchSkillFiles(): readonly WorkbenchSkillFile[] {
  const root = workbenchSkillDir();
  const files: WorkbenchSkillFile[] = [];
  walk(root, root, files);
  if (!files.some((file) => file.path === 'SKILL.md')) {
    throw new Error(`技能目录缺 SKILL.md：${root}`);
  }
  return files;
}

const frontmatterDescription = (text: string): string => {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return '';
  const block = match[1] ?? '';
  const line = block.split('\n').find((row) => row.startsWith('description:'));
  return line ? line.slice('description:'.length).trim() : '';
};

export function workbenchSkillManifest(): {
  readonly name: string;
  readonly description: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
} {
  const files = workbenchSkillFiles();
  const skill = files.find((file) => file.path === 'SKILL.md')!;
  return {
    name: WORKBENCH_SKILL_NAME,
    description: frontmatterDescription(skill.text),
    files: files.map((file) => ({ path: file.path, content: file.text }))
  };
}

export const workbenchSkillUri = (path: string): string => `${WORKBENCH_SKILL_URI_PREFIX}${path}`;

export function workbenchSkillFileByUri(uri: string): WorkbenchSkillFile | undefined {
  if (!uri.startsWith(WORKBENCH_SKILL_URI_PREFIX)) return undefined;
  const path = uri.slice(WORKBENCH_SKILL_URI_PREFIX.length);
  return workbenchSkillFiles().find((file) => file.path === path);
}

/** 不压缩的 zip（目录名为 agent-hub-workbench/…），方便浏览器「另存为」后直接解压。 */
export function workbenchSkillZip(): Uint8Array {
  const files = workbenchSkillFiles();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const encode = (value: string) => Buffer.from(value, 'utf8');
  const u16 = (value: number) => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(value);
    return buf;
  };
  const u32 = (value: number) => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value);
    return buf;
  };
  for (const file of files) {
    const name = encode(`${WORKBENCH_SKILL_NAME}/${file.path}`);
    const crc = crc32(file.bytes) >>> 0;
    const local = Buffer.concat([
      Buffer.from('PK\x03\x04'),
      u16(20),
      u16(0x800),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(file.bytes.length),
      u32(file.bytes.length),
      u16(name.length),
      u16(0),
      name,
      Buffer.from(file.bytes)
    ]);
    const central = Buffer.concat([
      Buffer.from('PK\x01\x02'),
      u16(20),
      u16(20),
      u16(0x800),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(file.bytes.length),
      u32(file.bytes.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name
    ]);
    localParts.push(local);
    centralParts.push(central);
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    Buffer.from('PK\x05\x06'),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0)
  ]);
  return new Uint8Array(Buffer.concat([...localParts, central, eocd]));
}
