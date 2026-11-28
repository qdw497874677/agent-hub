import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServiceDto } from '@agent-hub/contract';
import { servicesApi } from '../shell/api.ts';
import { serviceKeys } from '../shell/query-keys.ts';
import { SMALL_BUTTON } from '../shell/dialog-shell.tsx';
import { useCompact } from '../shell/device.ts';
import { resolveWorker, useWorkers } from '../shell/workers.tsx';
import { PreviewWorkflowAction } from './preview-workflow.tsx';
import {
  SERVICE_LOG_MAX,
  serviceCommandProblem,
  serviceMetaText,
  servicePortProblem,
  servicePortText,
  serviceRootProblem,
  serviceStateText,
  serviceStateTone,
  sortServices,
  type ServiceStateFlags
} from './service-links.ts';

/**
 * 「本地服务」（docs/design/session-service.md §4 / §9）。
 *
 * 一块看向这台机器上被托管着的进程：谁在跑、占哪个端口、跑了多久、最后输出了什么。
 * 状态一律以列表接口为准——`stop` 的回包是停止前读出来的那一行，拿它渲染会显示「还在跑」。
 * 没有服务时只有一行「＋ 起个服务」，不占位；有服务时才展开成一条条。
 */

const INPUT =
  'w-full min-w-0 rounded-sm border border-hair bg-card px-2 py-1.5 font-mono text-meta text-primary outline-none placeholder:font-sans placeholder:text-tertiary focus:border-ring';
const ACTION = `${SMALL_BUTTON} inline-flex min-h-7 items-center justify-center`;
const PRIMARY =
  'inline-flex min-h-8 items-center justify-center rounded-sm bg-action px-2.5 py-1 text-meta text-action-fg hover:bg-action/90 disabled:opacity-40';
const TONE: Record<string, string> = { sage: 'text-sage', accent: 'text-accent', rust: 'text-rust', tertiary: 'text-tertiary' };

const message = (error: unknown): string =>
  error instanceof Error && error.message !== '' ? error.message : '没成功，过一会儿再试';

/** 页面藏起来就停轮询：手机切到别的应用时别在后台每两秒问一次机器。 */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

export interface ServiceSessionChoice {
  readonly id: string;
  readonly label: string;
  /** 这条会话的工作目录：新建表单里预填，也说明服务会跑在哪。 */
  readonly root: string | null;
}

export type ServiceScope =
  | { readonly kind: 'task'; readonly taskId: string }
  | { readonly kind: 'session'; readonly sessionId: string };

interface Props {
  readonly taskId: string;
  /** 任务页看整个任务的，会话检查器看这条会话的。 */
  readonly scope: ServiceScope;
  /** 可以从哪条会话起服务（默认第一条）。 */
  readonly choices: readonly ServiceSessionChoice[];
  readonly defaultSessionId?: string | null;
  /** 容器会话没有工作目录，起不了本地服务。 */
  readonly canCreate?: boolean;
}

/** 乐观插入的那一行：只用来占位，字段凑齐 ServiceDto 的形状即可。 */
function optimisticRow(draft: {
  sessionId: string;
  command: string;
  port: number | null;
  root: string | null;
}): ServiceDto {
  return {
    id: 'svc_pending',
    projectId: '',
    taskId: null,
    workspaceId: null,
    sessionId: draft.sessionId,
    workerId: '',
    root: draft.root ?? '',
    command: draft.command,
    port: draft.port,
    env: {},
    restart: 'on-demand',
    state: 'starting',
    pid: null,
    detail: null,
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
}

export function SessionServices({ taskId, scope, choices, defaultSessionId = null, canCreate = true }: Props) {
  const compact = useCompact();
  const visible = useDocumentVisible();
  const client = useQueryClient();
  const workers = useWorkers();

  const [creating, setCreating] = useState(false);
  const [command, setCommand] = useState('');
  const [port, setPort] = useState('');
  const [root, setRoot] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(defaultSessionId ?? choices[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<readonly ServiceDto[]>([]);
  const [stopping, setStopping] = useState<readonly string[]>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [logId, setLogId] = useState<string | null>(null);
  const [showProcesses, setShowProcesses] = useState(false);

  /** 换了一条会话（检查器里切会话）：新建表单跟着换，别把服务起在旧会话下。 */
  useEffect(() => {
    if (defaultSessionId !== null) setSessionId(defaultSessionId);
  }, [defaultSessionId]);

  const listKey = scope.kind === 'task' ? serviceKeys.forTask(scope.taskId) : serviceKeys.forSession(scope.sessionId);
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => (scope.kind === 'task' ? servicesApi.listForTask(scope.taskId) : servicesApi.listForSession(scope.sessionId)),
    // 有两件事值得快一点问：刚起的服务在等状态，刚发的停止指令在等回报。其余时候 5 秒足够。
    refetchInterval: (query) => {
      if (!visible) return false;
      const rows = query.state.data ?? [];
      const busy = rows.some((row) => row.state === 'starting') || optimistic.length > 0 || stopping.length > 0;
      return busy ? 2000 : 5000;
    },
    refetchOnWindowFocus: true,
    retry: false
  });

  const real = list.data ?? [];
  // 自动端口的服务建完后 port 还是 null，机器回报时才补上——所以只按会话 + 命令认领，别把端口算进来。
  const pending = optimistic.filter(
    (row) =>
      Date.now() - row.updatedAt < 20_000 &&
      !real.some((svc) => svc.command === row.command && svc.sessionId === row.sessionId)
  );
  const services = sortServices([...real, ...pending]);

  const processSessionId = scope.kind === 'session' ? scope.sessionId : defaultSessionId;
  const processes = useQuery({
    queryKey: serviceKeys.processes(processSessionId ?? 'none'),
    queryFn: () => servicesApi.processes(processSessionId ?? ''),
    enabled: processSessionId !== null && real.length > 0,
    refetchInterval: showProcesses && visible ? 5000 : false,
    staleTime: 10_000,
    retry: false
  });

  const logs = useQuery({
    queryKey: serviceKeys.logs(logId ?? 'none'),
    queryFn: () => servicesApi.logs(logId ?? '', SERVICE_LOG_MAX),
    enabled: logId !== null,
    refetchInterval: visible ? 5000 : false,
    retry: false
  });

  const stoppingKey = stopping.join(',');
  /** 拉到的状态走到头了才把「停止中」摘掉；回包不算数。 */
  useEffect(() => {
    if (stopping.length === 0) return;
    const done = new Set(real.filter((svc) => svc.state === 'stopped' || svc.state === 'failed').map((svc) => svc.id));
    if (stopping.every((id) => done.has(id))) setStopping([]);
  }, [real, stoppingKey]);

  /** 二十秒还没回报：话说明白，别让人一直盯着「停止中」。 */
  useEffect(() => {
    if (stopping.length === 0) return;
    const timer = window.setTimeout(() => {
      setStopping([]);
      setError('停止指令已经发出，机器还没回报状态；它可能还在收尾。');
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, [stoppingKey]);

  const refresh = () => {
    void client.invalidateQueries({ queryKey: listKey });
    void list.refetch();
  };

  const stop = useMutation({
    mutationFn: (id: string) => servicesApi.stop(id),
    onMutate: (id) => {
      setConfirmId(null);
      setMenuId(null);
      setError(null);
      setStopping((rows) => (rows.includes(id) ? rows : [...rows, id]));
    },
    // 回包的 service 是 stop 之前读出来的，state 往往还是 running，直接丢掉。
    onSuccess: refresh,
    onError: (failure, id) => {
      setStopping((rows) => rows.filter((row) => row !== id));
      setError(message(failure));
    }
  });

  const create = useMutation({
    mutationFn: (draft: { sessionId: string; command: string; port: number | null; root: string | null }) =>
      servicesApi.create(taskId, {
        sessionId: draft.sessionId,
        command: draft.command,
        restart: 'on-demand',
        ...(draft.port === null ? {} : { port: draft.port }),
        ...(draft.root === null ? {} : { root: draft.root })
      }),
    onMutate: (draft) => {
      setError(null);
      setOptimistic((rows) => [...rows, optimisticRow(draft)]);
    },
    onSuccess: (_service, draft) => {
      setCreating(false);
      setCommand('');
      setPort('');
      setRoot(choices.find((choice) => choice.id === draft.sessionId)?.root ?? '');
      refresh();
    },
    onError: (failure, draft) => {
      setOptimistic((rows) => rows.filter((row) => !(row.command === draft.command && row.sessionId === draft.sessionId)));
      setError(message(failure));
    }
  });

  const openCreate = () => {
    setCreating(true);
    setError(null);
    setRoot(choices.find((choice) => choice.id === sessionId)?.root ?? '');
  };

  const submit = () => {
    const commandProblem = serviceCommandProblem(command);
    const portProblem = servicePortProblem(port);
    const rootProblem = serviceRootProblem(root);
    if (commandProblem !== null) return setError(commandProblem);
    if (portProblem !== null) return setError(portProblem);
    if (rootProblem !== null) return setError(rootProblem);
    if (sessionId === null) return setError(choices.length === 0 ? '这个任务还没有会话，先开一条再起服务' : '先选一条会话');
    create.mutate({
      sessionId,
      command: command.trim(),
      port: port.trim() === '' ? null : Number(port.trim()),
      root: root.trim() === '' ? null : root.trim()
    });
  };

  const now = Date.now();
  const failedDetail = services.find((svc) => svc.state === 'failed' && svc.detail !== null)?.detail ?? null;
  const shownError = error ?? failedDetail;
  // 容器会话既起不了服务、也没有服务可看：整块不渲染，别在抽屉里留一条空线。
  if (!canCreate && services.length === 0 && !creating && shownError === null) return null;
  const canStop = (service: ServiceDto) => service.state === 'running' || service.state === 'starting';
  const workerOffline = (service: ServiceDto): boolean => {
    // 还没落库的乐观行没有 workerId，别凭空说机器离线。
    if (service.id === 'svc_pending' || workers.list.length === 0) return false;
    return resolveWorker(workers.list, service.workerId)?.state !== 'online';
  };

  const actions = (service: ServiceDto) => (
    <>
      {service.id === 'svc_pending' ? null : (
        <>
          {canStop(service) ? (
            <button
              type="button"
              data-testid="service-stop"
              className={ACTION}
              disabled={stopping.includes(service.id)}
              onClick={() => {
                setConfirmId(service.id);
                setMenuId(null);
              }}
            >
              {stopping.includes(service.id) ? '停止中…' : '停止'}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="service-logs"
            className={ACTION}
            onClick={() => {
              setLogId(logId === service.id ? null : service.id);
              setMenuId(null);
            }}
          >
            {logId === service.id ? '收起日志' : '看日志'}
          </button>
          <ServicePreviewAction service={service} />
        </>
      )}
    </>
  );

  const stateLabel = (service: ServiceDto) => {
    const flags: ServiceStateFlags = {
      offline: workerOffline(service),
      stopping: stopping.includes(service.id)
    };
    return (
      <span data-testid="service-state" className={`shrink-0 text-meta ${TONE[serviceStateTone(service.state, flags)]}`}>
        {serviceStateText(service.state, flags)}
      </span>
    );
  };

  const commandButton = (service: ServiceDto) => (
    <button
      type="button"
      data-testid="service-command"
      title={expandedId === service.id ? '收起命令' : service.command}
      className="min-w-0 flex-1 truncate text-left font-mono text-meta text-primary hover:text-primary"
      onClick={() => setExpandedId(expandedId === service.id ? null : service.id)}
    >
      {service.command}
    </button>
  );

  return (
    <div className="space-y-1.5">
      {services.length > 0 ? (
        <section data-testid="session-services" className="space-y-1.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <p className="shrink-0 text-meta text-tertiary">本地服务</p>
            {canCreate && !creating ? (
              <button
                type="button"
                data-testid="service-new"
                className="ml-auto shrink-0 text-meta text-tertiary hover:text-primary"
                onClick={openCreate}
              >
                ＋ 起一个
              </button>
            ) : null}
          </div>

          <ul className="space-y-1.5">
            {services.map((service) => (
              <li
                key={service.id}
                data-testid="service-row"
                data-service-id={service.id}
                data-service-state={service.state}
                className="min-w-0 rounded-sm border border-hair bg-card px-2 py-1.5"
              >
                {compact ? (
                  <>
                    <div className="flex min-w-0 items-center gap-1.5">
                      {stateLabel(service)}
                      {commandButton(service)}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-2 text-meta text-tertiary">
                      <span data-testid="service-port" className="shrink-0 font-mono">
                        {servicePortText(service.port)}
                      </span>
                      <span className="min-w-0 truncate">{serviceMetaText(service, now)}</span>
                      {service.id === 'svc_pending' ? null : (
                        <button
                          type="button"
                          data-testid="service-more"
                          aria-label="更多操作"
                          aria-expanded={menuId === service.id}
                          className="ml-auto h-7 shrink-0 px-1.5 text-meta text-tertiary hover:text-primary"
                          onClick={() => setMenuId(menuId === service.id ? null : service.id)}
                        >
                          ⋯
                        </button>
                      )}
                    </div>
                    {menuId === service.id ? <div className="mt-1 flex flex-wrap items-center gap-1.5">{actions(service)}</div> : null}
                  </>
                ) : (
                  <div className="flex min-w-0 items-baseline gap-2">
                    {stateLabel(service)}
                    {commandButton(service)}
                    <span data-testid="service-port" className="shrink-0 font-mono text-meta text-tertiary">
                      {servicePortText(service.port)}
                    </span>
                    <span className="shrink-0 text-meta text-tertiary">{serviceMetaText(service, now)}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-1.5">{actions(service)}</span>
                  </div>
                )}

                {expandedId === service.id ? (
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-canvas px-2 py-1 font-mono text-meta leading-[1.5] text-secondary">
                    {service.command}
                  </pre>
                ) : null}

                {confirmId === service.id ? (
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 rounded-sm border border-rust/40 bg-canvas px-2 py-1 text-meta">
                    <span className="min-w-0 flex-1 text-secondary">停掉这条服务？它占的端口会空出来。</span>
                    <button
                      type="button"
                      data-testid="service-stop-confirm"
                      className="shrink-0 rounded-sm bg-rust px-2 py-0.5 text-canvas disabled:opacity-40"
                      disabled={stop.isPending}
                      onClick={() => stop.mutate(service.id)}
                    >
                      停
                    </button>
                    <button type="button" className="shrink-0 text-tertiary hover:text-primary" onClick={() => setConfirmId(null)}>
                      算了
                    </button>
                  </div>
                ) : null}

                {logId === service.id ? (
                  <div className="mt-1 rounded-sm border border-hair bg-canvas">
                    <div className="flex items-center gap-2 border-b border-hair px-2 py-1">
                      <span className="text-meta text-tertiary">最后 8 KiB</span>
                      <button
                        type="button"
                        className="text-meta text-tertiary hover:text-primary disabled:opacity-50"
                        disabled={logs.isFetching}
                        onClick={() => void logs.refetch()}
                      >
                        {logs.isFetching ? '刷新中…' : '刷新'}
                      </button>
                      <button type="button" className="ml-auto text-meta text-tertiary hover:text-primary" onClick={() => setLogId(null)}>
                        关闭
                      </button>
                    </div>
                    <pre
                      data-testid="service-log-text"
                      className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-meta leading-[1.5] text-secondary"
                    >
                      {logs.data ?? (logs.isLoading ? '读取中…' : logs.error ? message(logs.error) : '还没有输出')}
                    </pre>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>

          {processSessionId !== null && (processes.data?.length ?? 0) > 0 ? (
            <div data-testid="session-processes" className="border-t border-hair pt-1">
              <button
                type="button"
                className="text-meta text-tertiary hover:text-primary"
                aria-expanded={showProcesses}
                onClick={() => {
                  setShowProcesses(!showProcesses);
                  if (!showProcesses) void processes.refetch();
                }}
              >
                {showProcesses ? '收起' : '这台机器上还跑着'} {processes.data?.length} 个进程
              </button>
              {showProcesses ? (
                <ul className="mt-1 space-y-0.5">
                  {(processes.data ?? []).map((process) => (
                    <li key={process.pid} data-testid="process-row" className="flex min-w-0 items-baseline gap-2 text-meta">
                      <span className="min-w-0 flex-1 truncate font-mono text-secondary" title={process.cmd}>
                        {process.cmd}
                      </span>
                      <span className="shrink-0 font-mono text-tertiary">
                        {process.pid}
                        {process.ports.length > 0 ? ` · :${process.ports.join(' :')}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {shownError !== null ? (
        <p role="alert" data-testid="service-error" className="text-meta text-rust">
          {shownError}
        </p>
      ) : null}

      {services.length === 0 && canCreate && !creating ? (
        <button type="button" data-testid="service-new" className="text-meta text-tertiary hover:text-primary" onClick={openCreate}>
          ＋ 在这台机器上起个服务
        </button>
      ) : null}

      {creating ? (
        <form
          data-testid="service-new-form"
          className="space-y-1.5 rounded-sm border border-hair bg-card px-2 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="block min-w-0">
            <span className="text-meta text-tertiary">命令</span>
            <input
              data-testid="service-new-command"
              className={`${INPUT} mt-0.5`}
              placeholder="npm run dev"
              spellCheck={false}
              autoComplete="off"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
          </label>
          <div className="flex min-w-0 flex-wrap gap-1.5">
            <label className="min-w-[92px] flex-1">
              <span className="text-meta text-tertiary">端口</span>
              <input
                data-testid="service-new-port"
                className={`${INPUT} mt-0.5`}
                placeholder="留空自动"
                inputMode="numeric"
                autoComplete="off"
                value={port}
                onChange={(event) => setPort(event.target.value)}
              />
            </label>
            <label className="min-w-[140px] flex-[2]">
              <span className="text-meta text-tertiary">工作空间</span>
              <input
                data-testid="service-new-root"
                className={`${INPUT} mt-0.5`}
                placeholder="当前会话的工作目录"
                spellCheck={false}
                autoComplete="off"
                value={root}
                onChange={(event) => setRoot(event.target.value)}
              />
            </label>
          </div>
          {choices.length > 1 ? (
            <label className="block min-w-0">
              <span className="text-meta text-tertiary">从哪条会话起</span>
              <select
                className="mt-0.5 w-full min-w-0 rounded-sm border border-hair bg-card px-2 py-1.5 text-meta text-primary outline-none focus:border-ring"
                value={sessionId ?? ''}
                onChange={(event) => {
                  const next = event.target.value === '' ? null : event.target.value;
                  setSessionId(next);
                  setRoot(choices.find((choice) => choice.id === next)?.root ?? '');
                }}
              >
                {choices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="flex min-w-0 items-center gap-2">
            <button type="submit" data-testid="service-new-submit" className={PRIMARY} disabled={create.isPending}>
              {create.isPending ? '提交中…' : '起服务'}
            </button>
            <button
              type="button"
              className="text-meta text-tertiary hover:text-primary"
              onClick={() => {
                setCreating(false);
                setError(null);
              }}
            >
              取消
            </button>
            <span className="ml-auto min-w-0 truncate text-meta text-tertiary" title={choices.find((choice) => choice.id === sessionId)?.label}>
              {choices.find((choice) => choice.id === sessionId)?.label ?? ''}
            </span>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function ServicePreviewAction({ service }: { service: ServiceDto }) {
  if (service.sessionId === null || service.port === null || service.id === 'svc_pending') return null;
  return <PreviewWorkflowAction key={`${service.sessionId}:${service.workerId}:${service.port}`} sessionId={service.sessionId} service={{ port: service.port, workerId: service.workerId }} compact />;
}
