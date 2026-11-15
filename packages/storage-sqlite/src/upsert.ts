/**
 * 按列 upsert。
 *
 * `INSERT OR REPLACE` 在 SQLite 里是「先删整行再插」，一旦表上后来加了列（迁移、
 * 灰度期的新字段），旧代码的整行写法就会把那些列清成默认值。这里改成标准的
 * `ON CONFLICT(key) DO UPDATE SET col = excluded.col`：只覆盖本次写到的列，
 * 没列出来的列保持原值。往后的迁移加列只需要改读侧，不再要求所有写点同步跟进。
 */
export function upsertSql(table: string, columns: readonly string[], key = 'id'): string {
  const sets = columns
    .filter((column) => column !== key)
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${key}) DO UPDATE SET ${sets}`;
}
