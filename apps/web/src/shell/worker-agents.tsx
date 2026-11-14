import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { workerApi, type AgentAliasDto, type WorkerInfoDto } from './api.ts';
import { canAdminister, isOwner, useAccount } from './account-context.ts';
import { SMALL_BUTTON } from './dialog-shell.tsx';
import {
  MAX_ALIASES,
  aliasRowProblem,
  aliasRowsFrom,
  aliasRowsValue,
  aliasesProblem,
  emptyAgentAlias,
  isBlankAliasRow,
  type AgentAliasRow
} from '../surfaces/workbench/agent-aliases.ts';

/**
 * 机器页展开区里的「运行时别名」：一台机器能跑哪些 ACP agent。
 *
 * 这些别名就是可执行命令，属于操作者（那台机器的拥有者）的信任边界：
 * owner 能改，admin 只读，其他人整块不出现（服务端同样按角色挡）。
 * 保存后 hub 把新配置推给在线 worker，只影响之后新建的会话；正在跑的会话不变。
 */

const INPUT = 'w-full min-w-0 rounded-sm border bg-card px-2 py-1 text-meta text-primary outline-none placeholder:text-tertiary focus:border-accent';

type FieldKey = keyof AgentAliasRow;

/** 一行里的六个输入：面板宽度只有 ~340px（桌面和手机都是这个宽度），一律上下堆叠。 */
const FIELDS: ReadonlyArray<{ key: FieldKey; label: string; testid: string; placeholder: string }> = [
  { key: 'id', label: 'id', testid: 'worker-agent-id', placeholder: 'claude' },
  { key: 'label', label: '名称（不填就用 id）', testid: 'worker-agent-label', placeholder: 'Claude Code' },
  { key: 'command', label: '命令', testid: 'worker-agent-command', placeholder: 'claude-code-acp' },
  { key: 'args', label: '参数（逗号分隔）', testid: 'worker-agent-args', placeholder: '--acp, --verbose' },
  { key: 'models', label: '模型（逗号分隔，可选）', testid: 'worker-agent-models', placeholder: 'claude-sonnet-4-5, claude-opus-4' },
  { key: 'defaultModel', label: '默认模型（可选）', testid: 'worker-agent-default-model', placeholder: 'claude-sonnet-4-5' }
];

/** 改一个字段（`field` 全是字符串字段，所以整体复制再赋值是类型安全的）。 */
function withField(row: AgentAliasRow, field: FieldKey, value: string): AgentAliasRow {
  return { ...row, [field]: value };
}

const message = (error: unknown): string | null => (error instanceof Error ? error.message : error ? '网络出错了，再试一次' : null);

export function AgentAliasesSection({ worker }: { worker: WorkerInfoDto }) {
  const me = useAccount();
  const viewable = canAdminister(me);
  const editable = isOwner(me);
  const queryClient = useQueryClient();

  const key = ['workers', worker.workerId, 'agents'] as const;
  const config = useQuery({ queryKey: key, queryFn: () => workerApi.agents(worker.workerId), enabled: viewable, retry: false });
  const [draft, setDraft] = useState<AgentAliasRow[] | null>(null);
  const [attempted, setAttempted] = useState(false);

  const save = useMutation({
    mutationFn: (aliases: AgentAliasDto[]) => workerApi.saveAgents(worker.workerId, aliases),
    onSuccess: (data) => {
      queryClient.setQueryData(key, data);
      setDraft(null);
      setAttempted(false);
      void queryClient.invalidateQueries({ queryKey: ['workers'] });
    }
  });

  const base = config.data ? aliasRowsFrom(config.data.aliases) : [];
  const rows = draft ?? base;
  const listProblem = aliasesProblem(rows);
  // 整行空着（刚点「添加别名」还没写）不算错误：保存时直接丢掉。
  const problems = rows.map((row) => (isBlankAliasRow(row) ? null : aliasRowProblem(row)));
  const blocked = listProblem !== null || problems.some((problem) => problem !== null);
  const loaded = config.data?.aliases ?? [];

  if (!viewable) return null;

  const edit = (next: (rows: AgentAliasRow[]) => AgentAliasRow[]) => {
    save.reset();
    setDraft((current) => next(current ?? base));
  };

  const submit = () => {
    setAttempted(true);
    if (blocked) return;
    save.reset();
    save.mutate(aliasRowsValue(rows));
  };

  const error = message(save.error) ?? (attempted ? listProblem ?? problems.find((problem) => problem !== null) ?? null : null);
  const saving = save.isPending;

  return (
    <>
      <dt className="text-tertiary">运行时别名</dt>
      <dd className="min-w-0" data-testid="worker-agents">
        <p className="text-meta text-tertiary">
          这些是可执行命令，属于操作者信任边界；保存后对新会话生效，正在跑的会话不变。
        </p>
        <p className="mt-1 text-meta text-tertiary">
          填了别名就<strong className="font-normal text-secondary">只按别名里的清单</strong>
          提供 ACP agent（OpenCode 这类内置 ACP agent 会被替换，Pi / Grok / Codex 这类独立适配器不受影响）；留空则回到这台机器自己的配置。
        </p>

        {config.isPending ? <p className="mt-1.5 text-meta text-tertiary">加载中…</p> : null}
        {config.isError ? (
          <p role="alert" data-testid="worker-agent-error" className="mt-1.5 text-meta text-rust">
            {message(config.error) ?? '读不到这台机器的别名配置'}
          </p>
        ) : null}

        {!editable ? (
          // admin：只看，不给按钮（保存是 owner 的事，摆个灰掉的按钮只会让人猜为什么点不动）
          config.isPending || config.isError ? null : loaded.length === 0 ? (
            <p className="mt-1.5 text-meta text-tertiary">这台机器还没配运行时别名。</p>
          ) : (
            <ul className="mt-1.5 flex min-w-0 flex-col gap-1.5">
              {loaded.map((alias) => (
                <li key={alias.id} data-testid="worker-agent-row" className="min-w-0 rounded-sm border border-hair px-2 py-1.5">
                  <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                    <span className="break-all font-mono text-secondary">{alias.id}</span>
                    <span className="break-words text-primary">{alias.label || alias.id}</span>
                  </p>
                  <p className="break-all font-mono text-[11px] text-tertiary">
                    {[alias.command, ...(alias.args ?? [])].join(' ')}
                  </p>
                  {alias.models && alias.models.length > 0 ? (
                    <p className="break-all text-[11px] text-tertiary">模型 {alias.models.join(', ')}</p>
                  ) : null}
                  {alias.defaultModel ? <p className="break-all text-[11px] text-tertiary">默认模型 {alias.defaultModel}</p> : null}
                </li>
              ))}
            </ul>
          )
        ) : config.isPending || config.isError ? null : (
          <>
            {rows.length === 0 ? (
              <p className="mt-1.5 text-meta text-tertiary">还没配别名。点「添加别名」写一条，会话里就能选它。</p>
            ) : null}

            <div className="mt-1.5 flex min-w-0 flex-col gap-2">
              {rows.map((row, index) => {
                const bad = attempted && Boolean(problems[index]);
                return (
                  <div
                    key={index}
                    data-testid="worker-agent-row"
                    className={`flex min-w-0 flex-col gap-1.5 rounded-sm border p-2 ${bad ? 'border-rust' : 'border-hair'}`}
                  >
                    <div className="grid min-w-0 grid-cols-1 gap-1.5">
                      {FIELDS.map((field) => (
                        <label key={field.key} className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-[11px] text-tertiary">{field.label}</span>
                          <input
                            data-testid={field.testid}
                            className={`${INPUT} font-mono ${bad ? 'border-rust' : 'border-hair'}`}
                            value={row[field.key]}
                            placeholder={field.placeholder}
                            spellCheck={false}
                            autoComplete="off"
                            onChange={(event) => {
                              const value = event.target.value;
                              edit((current) => current.map((item, at) => (at === index ? withField(item, field.key, value) : item)));
                            }}
                          />
                        </label>
                      ))}
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span className="min-w-0 break-words text-meta text-rust">{attempted ? problems[index] : null}</span>
                      <button
                        data-testid="worker-agent-remove"
                        className={SMALL_BUTTON}
                        aria-label={`删除别名 ${row.id === '' ? index + 1 : row.id}`}
                        onClick={() => edit((current) => current.filter((_, at) => at !== index))}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
              <button
                data-testid="worker-agent-add"
                className={SMALL_BUTTON}
                disabled={rows.length >= MAX_ALIASES}
                title={rows.length >= MAX_ALIASES ? `最多 ${MAX_ALIASES} 个别名` : undefined}
                onClick={() => edit((current) => [...current, emptyAgentAlias()])}
              >
                添加别名
              </button>
              <button data-testid="worker-agent-save" className={SMALL_BUTTON} disabled={saving} onClick={submit}>
                {saving ? '保存中…' : '保存'}
              </button>
              <span className="ml-auto text-meta text-tertiary">
                {rows.length}/{MAX_ALIASES}
              </span>
            </div>

            {error ? (
              <p role="alert" data-testid="worker-agent-error" className="mt-1.5 text-meta text-rust">
                {error}
              </p>
            ) : null}
            {save.isSuccess ? (
              <p role="status" className="mt-1.5 text-meta text-sage">
                已保存，新会话生效
              </p>
            ) : null}
          </>
        )}
      </dd>
    </>
  );
}
