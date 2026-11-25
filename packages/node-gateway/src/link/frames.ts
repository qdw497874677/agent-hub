import type { ServerToWorker } from '@agent-hub/contract';
import { commandCapability } from '@agent-hub/domain';
import type { RuntimeJobReport } from '../runtime-jobs.ts';
import type { UpdateReport } from '../updater.ts';
import { denial, message, type LinkCtx, type SessionCommand } from './ctx.ts';
import type { Sessions } from './sessions.ts';
import type { Transport } from './transport.ts';
import { closeTerminals } from './channels.ts';

export interface Frames {
  /** 会话指令的失败清理（与分发保持在同一处）。 */
  handle(command: SessionCommand): Promise<void>;
  /** 越权的指令：不执行，按指令种类回一个「被拒」，hub 那边不会干等。 */
  refuse(command: ServerToWorker): void;
  update(commit: string): Promise<void>;
  runtimeJob(command: Extract<ServerToWorker, { kind: 'runtime_job' }>): Promise<void>;
}

/** 下行帧分发与会话指令的失败清理。 */
export function installFrames(ctx: LinkCtx, sessions: Sessions, transport: Transport): Frames {
  const options = ctx.options;
  const send = transport.send;

  /**
   * 一条指令失败不能静默。之前 `runtime.start` 抛错时异常沉进未处理的 Promise，
   * 日志里只留下「未知会话」——真正的错误被吞掉了，排障只能靠猜。
   */
  async function handle(command: SessionCommand): Promise<void> {
    try {
      await sessions.run(command);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      options.onLog?.(`${command.kind} 指令失败：${reason}`);
      // A prompt failure after adapter invocation is ambiguous; never tear down
      // a runtime that may already have been replaced while awaiting it.
      if (command.kind === 'prompt') return;
      send({
        type: 'event',
        sessionId: command.sessionId,
        event: { kind: 'ended', outcome: 'failed', reason: `${command.kind} 失败：${reason}` }
      });
      ctx.sessions.delete(command.sessionId);
      ctx.workspaces.delete(command.sessionId);
      sessions.forget(command.sessionId);
      await closeTerminals(ctx, command.sessionId);
    }
  }

  /** 越权的指令：不执行，按指令种类回一个「被拒」，hub 那边不会干等。 */
  function refuse(command: ServerToWorker): void {
    const reason = denial(ctx, commandCapability(command.kind)) ?? '不允许';
    options.onLog?.(`拒绝越权指令 ${command.kind}：${reason}`);
    if (command.kind === 'update') send({ type: 'update_status', state: 'refused', message: reason, logTail: '' });
    else if (command.kind === 'runtime_job') send({ type: 'runtime_job_status', jobId: command.jobId, state: 'refused', message: reason, lines: [] });
    else if (command.kind === 'start_session' || command.kind === 'prompt') {
      if (!sessions.refuse(command)) send({ type: 'event', sessionId: command.sessionId, event: { kind: 'ended', outcome: 'failed', reason } });
    }
  }

  async function update(commit: string): Promise<void> {
    const report = (status: UpdateReport): void => send({ type: 'update_status', ...status });
    if (!options.onUpdate) return report({ state: 'refused', message: '这台 Worker 不支持远程更新', logTail: '' });
    if (ctx.updating) return report({ state: 'refused', message: '已经在更新了', logTail: '' });
    ctx.updating = true;
    try {
      await options.onUpdate(commit, report);
    } catch (error) {
      report({ state: 'failed', message: `更新出错：${message(error)}`, logTail: '' });
    } finally {
      ctx.updating = false;
    }
  }

  async function runtimeJob(command: Extract<ServerToWorker, { kind: 'runtime_job' }>): Promise<void> {
    const report = (status: RuntimeJobReport): void => send({ type: 'runtime_job_status', ...status });
    if (!options.provisioner) return report({ jobId: command.jobId, state: 'refused', message: '这台 Worker 不支持在线安装', lines: [] });
    options.onLog?.(`运行时任务：${command.action} ${command.agentId} ${command.version ?? ''}`);
    try {
      await options.provisioner.run(command, (status) => {
        if (status.state !== 'running') options.onLog?.(`运行时任务 ${command.agentId}：${status.state} ${status.message}`);
        report(status);
        // 装好 / 卸掉：立刻重新探测，界面上的「未安装」跟着变
        if (status.state === 'succeeded') void transport.probe(true);
        if (status.state !== 'running') transport.reportInventory();
      });
    } catch (error) {
      report({ jobId: command.jobId, state: 'failed', message: `安装出错：${message(error)}`, lines: [] });
    }
  }

  return { handle, refuse, update, runtimeJob };
}
