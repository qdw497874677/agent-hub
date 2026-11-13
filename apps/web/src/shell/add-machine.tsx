import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { adminApi, type PairingDto, type WorkerInfoDto, type WorkerPreset } from './api.ts';
import { DialogShell, PRIMARY_BUTTON, SECONDARY_BUTTON } from './dialog-shell.tsx';

/**
 * 「添加机器」：签一个一次性接入码，给出在新机器上粘贴运行的一行命令。
 *
 * 码 15 分钟内有效、只能用一次；倒计时到 0 就让人重新生成，而不是留着一条已经失效的命令。
 * 新机器连上之后（列表里多出一台），对话框里直接告诉你「已连上」——不用来回切。
 */
export function AddMachineDialog({ workers, onClose }: { workers: readonly WorkerInfoDto[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const known = useRef<Set<string>>(new Set());
  const [preset, setPreset] = useState<WorkerPreset>('full');
  const issue = useMutation({
    mutationFn: (chosen: WorkerPreset) => adminApi.pairing(chosen),
    onSuccess: () => {
      known.current = new Set(workers.map((worker) => worker.workerId));
    }
  });
  const pairing = issue.data;
  const now = useNow(pairing ? 1000 : null);

  // 打开就签：多数人点「添加机器」就是要那行命令。
  const issueOnce = useRef(false);
  useEffect(() => {
    if (issueOnce.current) return;
    issueOnce.current = true;
    issue.mutate('full');
  }, [issue]);
  // 换预设 = 重新签一个码（旧码 15 分钟后自然失效）：能力写在码上，兑换时只能取交集
  const choose = (next: WorkerPreset): void => {
    if (next === preset) return;
    setPreset(next);
    issue.mutate(next);
  };

  useEffect(() => {
    if (pairing) void queryClient.invalidateQueries({ queryKey: ['workers'] });
  }, [pairing, queryClient]);

  const joined = pairing ? workers.find((worker) => worker.origin === 'remote' && !known.current.has(worker.workerId) && worker.state === 'online') : undefined;
  const left = pairing ? Math.max(0, pairing.expiresAt - now) : 0;
  const expired = pairing !== undefined && left === 0 && !joined;

  return (
    <DialogShell title="添加机器" onClose={onClose}>
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sub text-primary">添加机器</h2>
        <button className="text-meta text-tertiary hover:text-primary" onClick={onClose} aria-label="关闭">
          关闭
        </button>
      </div>

      {joined ? (
        <div className="rounded-sm border border-sage/50 bg-card px-3 py-3" role="status">
          <p className="text-body text-primary">✓ {joined.label} 已连上</p>
          <p className="mt-1 text-meta text-tertiary">之后新建项目和会话时可以选它。</p>
        </div>
      ) : (
        <>
          <p className="mb-2 text-meta text-secondary">在要加入的 Linux 机器上运行（需要 git 和 curl；没有 Node 26 会自动装，这时还要 tar 和 xz）：</p>
          {issue.isError ? (
            <p className="mb-2 text-meta text-rust" role="alert">
              {(issue.error as Error).message}
            </p>
          ) : null}
          <PresetPicker value={preset} onChange={choose} disabled={issue.isPending} />
          <CommandBox pairing={pairing} expired={expired} />
          <div className="mt-2 flex items-center justify-between gap-2 text-meta">
            <span className={expired ? 'text-rust' : 'text-tertiary'} aria-live="polite">
              {!pairing ? '正在生成接入码…' : expired ? '接入码已过期' : `${clock(left)} 后过期 · 只能用一次`}
            </span>
            {expired || issue.isError ? (
              <button className={PRIMARY_BUTTON} onClick={() => issue.mutate(preset)} disabled={issue.isPending}>
                重新生成
              </button>
            ) : pairing ? (
              <span className="flex items-center gap-1.5 text-tertiary">
                <span aria-hidden className="block size-[7px] animate-pulse rounded-full bg-accent" />
                等待新机器连上
              </span>
            ) : null}
          </div>
          <details className="mt-3 text-meta text-tertiary">
            <summary className="cursor-pointer select-none hover:text-secondary">它会做什么</summary>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
              <li>没有 Node 26 就装一份到 ~/.local/node26</li>
              <li>把 agent-hub 拉到 ~/agent-hub，切到和这台 hub 一样的版本</li>
              <li>用接入码换一个这台机器专属的凭据，存进 ~/.config/agent-hub/worker.env（权限 600）</li>
              <li>装成 systemd 服务，开机自启、断线重连</li>
            </ul>
            <p className="mt-1.5">
              这台机器上已经接入过一台、想再接入一台：在命令的 <span className="font-mono">bash</span> 前加{' '}
              <span className="font-mono">WORKER_INSTANCE=第二台的名字</span>，代码、配置、资产和服务都会单独一份。
            </p>
            <p className="mt-1.5">之后随时可以在这里吊销这台机器，它会立刻断开。</p>
          </details>
        </>
      )}
      {joined ? (
        <div className="mt-3 flex justify-end">
          <button className={SECONDARY_BUTTON} onClick={onClose}>
            完成
          </button>
        </div>
      ) : null}
    </DialogShell>
  );
}

const PRESETS: readonly { readonly id: WorkerPreset; readonly label: string; readonly hint: string }[] = [
  { id: 'full', label: '完整', hint: '能跑 agent、读写文件、git、推送 / 开 PR、装卸运行时、自更新' },
  { id: 'readonly', label: '只读', hint: '只能读文件，不能跑 agent' },
  { id: 'no-remote', label: '不能推送', hint: '能跑 agent 和本地 git，但 hub 不会替它推送或开 PR' },
  { id: 'no-install', label: '不能安装', hint: '不能装卸运行时，也不能远程自更新' }
];

/** 权限预设（ADR 0030 D3）：写在接入码上，之后只能收窄；要放宽得重新配对。 */
function PresetPicker({ value, onChange, disabled }: { value: WorkerPreset; onChange: (preset: WorkerPreset) => void; disabled: boolean }) {
  const current = PRESETS.find((p) => p.id === value) ?? PRESETS[0]!;
  return (
    <fieldset className="mb-2" data-testid="preset-picker">
      <legend className="mb-1 text-meta text-secondary">这台机器的权限</legend>
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-4" role="radiogroup">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={p.id === value}
            disabled={disabled}
            onClick={() => onChange(p.id)}
            className={`rounded-sm border px-2 py-1 text-meta ${
              p.id === value ? 'border-accent bg-accent/10 text-primary' : 'border-hair text-secondary hover:border-accent'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="mt-1 text-xs text-tertiary">
        {current.hint}。{value !== 'readonly' ? '能跑 agent 就等于能在那台机器上执行任意代码，这里限制的是 hub 自己的工具，不是沙箱。' : ''}之后只能收窄，放宽要重新配对。
      </p>
    </fieldset>
  );
}

function CommandBox({ pairing, expired }: { pairing: PairingDto | undefined; expired: boolean }) {
  const [copied, setCopied] = useState(false);
  const text = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    if (!pairing) return;
    if (await copyText(pairing.command)) setCopied(true);
    else if (text.current) selectContents(text.current); // 复制不了（非安全上下文）：至少选中，长按就能复制
  };
  return (
    <div className={`rounded-sm border border-hair bg-card ${expired ? 'opacity-40' : ''}`}>
      <code
        ref={text}
        className="block max-h-40 select-all overflow-y-auto break-all px-2.5 py-2 font-mono text-meta leading-relaxed text-primary"
        aria-label="安装命令"
      >
        {pairing ? pairing.command : '　'}
      </code>
      <div className="flex justify-end border-t border-hair px-1.5 py-1.5">
        <button
          className={`${PRIMARY_BUTTON} min-h-9 min-w-[5.5rem]`}
          onClick={() => void copy()}
          disabled={!pairing || expired}
        >
          {copied ? '已复制' : '复制命令'}
        </button>
      </div>
      {pairing?.shortCommand ? (
        <details className="border-t border-hair px-2.5 py-1.5 text-meta text-secondary" data-testid="short-command">
          <summary className="cursor-pointer">简短版（不校验 sha256，没有 sha256sum 的机器用）</summary>
          <code className="mt-1 block select-all break-all font-mono text-primary">{pairing.shortCommand}</code>
        </details>
      ) : null}
      {pairing && pairing.hubUrl.startsWith('http://') ? (
        <p className="border-t border-hair px-2.5 py-1.5 text-meta text-accent" data-testid="http-hint">
          hub 走的是 HTTP：sha256 校验只能防传输损坏，防不了中间人篡改。建议在 hub 前面加 HTTPS 反代。
        </p>
      ) : null}
    </div>
  );
}

/** 剩余毫秒 → m:ss。 */
export function clock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** 剪贴板 API 只在安全上下文里有（tailnet 上走 http 时没有），退回老办法。 */
async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 落到下面
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let done = false;
  try {
    done = document.execCommand('copy');
  } catch {
    done = false;
  }
  area.remove();
  return done;
}

function selectContents(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
