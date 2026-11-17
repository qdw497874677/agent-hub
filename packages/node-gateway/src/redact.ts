import { scrubCredentials } from './setup-script.ts';

/**
 * 不可信文本里的秘密统一打码（进程命令行、服务日志等共用）。
 *
 * `scrubCredentials` 是「日志里出现什么就抹什么」的通用版（URL 凭据、sk-/ghp_/AKIA、
 * Bearer、私钥块）；这里补上命令行 / 环境变量里更常见的键值形态：
 *
 * - `--token xxx` / `--token=xxx` / `--password xxx` / `--db-password=xxx`
 * - `FOO_TOKEN=xxx` / `DB_PASSWORD=xxx` / `AWS_SECRET_ACCESS_KEY=xxx`（键名含
 *   KEY / TOKEN / SECRET / PASSWORD / SALT）
 * - `Authorization: Bearer xxx`（短 token 也要抹）
 * - URL 里的 `user:pass@`（短密码也要抹）
 *
 * 只保留键名 / 前缀，值一律换成 `***`；不改变命令结构，便于人看懂在跑什么。
 */
export function redactSecrets(text: string): string {
  return scrubCredentials(text)
    // 命令行开关：`--token value` / `--token=value`；值可能带引号。
    .replace(
      /(--?[A-Za-z0-9-]*(?:token|password|passwd|secret|api-?key)[A-Za-z0-9-]*)(=|\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1$2***'
    )
    // 环境变量 / `KEY=value`：键名里出现敏感词就只留键名。
    .replace(
      /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|SALT)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s"'`]+)/gi,
      '$1=***'
    )
    // Bearer 兜底：短 token（scrubCredentials 只抹 20 字符以上的）。
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
    // URL 里的 user:pass@ 兜底：密码可以很短。
    .replace(/\b([A-Za-z][A-Za-z0-9_.+-]*):([^@\s/]+)@/g, '$1:***@');
}
