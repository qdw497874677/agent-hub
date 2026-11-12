/** 机器是否在线；null 表示 Server 本机。会话连线只允许连在线机器上的会话。 */
export interface WorkerPresence {
  online(workerId: string | null): Promise<boolean>;
}
