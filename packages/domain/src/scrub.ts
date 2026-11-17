/**
 * 日志 / 命令输出里的凭据擦除（服务日志、准备脚本输出、进程清单共用一套）。
 *
 * 放在 domain 里是为了让 hub 与 Worker 用同一套规则：Worker 的 setup-script 与
 * service-host 都复用这里，domain 的 `recordServiceLogUseCase` 也能在落库前再兜一遍。
 */
export function scrubCredentials(text: string): string {
  return text
    .replace(/([A-Za-z][A-Za-z0-9_.\-]*):([^\s@/]{4,})@/g, '$1:***@')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, 'sk-***')
    .replace(/\b(gh[pousru]_[A-Za-z0-9]{20,})/g, 'gh*_***')
    .replace(/\b(github_pat_[A-Za-z0-9_]{20,})/g, 'github_pat_***')
    .replace(/(?<![A-Za-z0-9])(AKIA[0-9A-Z]{16})(?![A-Za-z0-9])/g, 'AKIA***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._\-]{20,}/gi, '$1***')
    // KEY=value / TOKEN=value / SECRET=value / PASSWORD=value：键名含这些词一律抹掉值。
    .replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)=([^\s'"]+)/gi, '$1=***')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY----- *** -----END PRIVATE KEY-----');
}
