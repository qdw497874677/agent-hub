import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { SecretInfo, SecretVault } from '@agent-hub/domain';

/**
 * 密钥保险箱（MCP 资产引用的 `${secret:NAME}`）：AES-256-GCM 静态加密，node:crypto 内置实现。
 *
 * - 每条一个随机 12 字节 IV；密钥名作 AAD（把密文挪到别的名字下解不开）。
 * - 主密钥不进库：来自 HUB_SECRET_KEY（base64 的 32 字节）或数据目录里的 secret.key（首次自动生成，权限 600）。
 *   库和密钥分开备份 / 泄露，单拿一个都读不出明文。
 * - 明文只在 reveal 的返回值里出现；这个模块不打任何日志。
 */
const schemaFor = (table: string) => `
CREATE TABLE IF NOT EXISTS ${table} (
  name       TEXT PRIMARY KEY,
  iv         BLOB NOT NULL,
  tag        BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export const SECRET_SCHEMA = schemaFor('asset_secrets');

const KEY_BYTES = 32;
const TABLE = /^[a-z_]+$/;

/** 读主密钥：环境变量优先，否则数据目录里的 secret.key（没有就生成）。返回值只交给 createSecretVault。 */
export async function loadSecretKey(options: { readonly env?: string | undefined; readonly file: string }): Promise<Buffer> {
  if (options.env !== undefined && options.env !== '') {
    const key = Buffer.from(options.env, 'base64');
    if (key.length !== KEY_BYTES) throw new Error('HUB_SECRET_KEY 必须是 base64 编码的 32 字节');
    return key;
  }
  try {
    const key = Buffer.from((await readFile(options.file, 'utf8')).trim(), 'base64');
    if (key.length !== KEY_BYTES) throw new Error(`${options.file} 不是有效的主密钥（应为 base64 的 32 字节）`);
    await chmod(options.file, 0o600).catch(() => undefined);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const key = randomBytes(KEY_BYTES);
  // wx：并发启动时不互相覆盖
  await writeFile(options.file, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  return key;
}

/** table：不同用途分表（provider_secrets 不该出现在资产密钥列表里）；只接受字面量表名。 */
export function createSecretVault(db: DatabaseSync, key: Uint8Array, table = 'asset_secrets'): SecretVault {
  if (key.byteLength !== KEY_BYTES) throw new Error('主密钥必须是 32 字节');
  if (!TABLE.test(table)) throw new Error('表名不合法');
  db.exec(schemaFor(table));
  const upsert = db.prepare(
    `INSERT INTO ${table} (name, iv, tag, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`
  );
  const list = db.prepare(`SELECT name, updated_at FROM ${table} ORDER BY name`);
  const remove = db.prepare(`DELETE FROM ${table} WHERE name = ?`);
  const one = db.prepare(`SELECT iv, tag, ciphertext FROM ${table} WHERE name = ?`);

  return {
    async list(): Promise<SecretInfo[]> {
      return (list.all() as { name: string; updated_at: number }[]).map((row) => ({ name: row.name, updatedAt: row.updated_at }));
    },
    async put(name, value, at) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(name, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      upsert.run(name, iv, cipher.getAuthTag(), ciphertext, at);
    },
    async remove(name) {
      return Number(remove.run(name).changes) > 0;
    },
    async reveal(names) {
      const out: Record<string, string> = {};
      for (const name of new Set(names)) {
        const row = one.get(name) as { iv: Uint8Array; tag: Uint8Array; ciphertext: Uint8Array } | undefined;
        if (!row) continue;
        try {
          const decipher = createDecipheriv('aes-256-gcm', key, row.iv);
          decipher.setAAD(Buffer.from(name, 'utf8'));
          decipher.setAuthTag(row.tag);
          out[name] = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
        } catch {
          // 主密钥换了 / 密文被改：当作没设置（调用方会报「缺密钥：NAME」）
        }
      }
      return out;
    }
  };
}
