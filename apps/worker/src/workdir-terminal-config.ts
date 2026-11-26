/** Explicit opt-in; unset and all other values keep legacy terminal behavior. */
export function workdirTerminalEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['WORKER_WORKDIR_TERMINAL'] === '1';
}
