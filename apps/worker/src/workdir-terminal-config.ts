/** Explicit opt-in; unset and all other values keep legacy terminal behavior. */
export function workdirTerminalEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['WORKER_WORKDIR_TERMINAL'] === '1';
}

/** Fail closed when the effective uid or a valid secure WebSocket URL is unavailable. */
export function workdirTerminalManaged(enabled: boolean, hubUrl: string, uid: number | undefined): boolean {
  if (!enabled || uid === undefined || uid === 0) return false;
  try { return new URL(hubUrl).protocol === 'wss:'; } catch { return false; }
}
