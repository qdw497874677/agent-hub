import { MessagesEntry } from '../messages-entry.tsx';
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { marketApi, teamApi, type AssetKindDto, type AssetScopeDto, type MarketAssetDto } from '../api.ts';
import { AccountMenu, useAccount } from '../auth.tsx';
import { DialogShell, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../dialog-shell.tsx';
import { formatRoute, type MarketTab } from '../route.ts';
import { INPUT, SMALL, DANGER, at, errorText, Section, Panel, Empty } from '../admin/shared.tsx';
import { encodeFiles, readPicked, type PickedFile } from '../admin/asset-files.ts';
import { ReviewPage } from './review.tsx';
import { SCOPE_TEXT, STATUS_TEXT, KIND_TEXT } from './labels.ts';
import { NotificationBell } from './notifications.tsx';

/**
 * 资产市场（#/assets/<分页>）：人人可用。目录 = 已上架、我看得见的；我的 = 我上架的（含待审 / 被驳回）；
 * 待审 = 轮到我审的提交 + 等我批的安装申请；设置 = 审核人、双人审核、团队 / 个人密钥。
 * 窄屏（390px）下分页是顶部一排、卡片单列。
 */
const TABS: readonly { id: MarketTab; label: string }[] = [
  { id: 'catalog', label: '目录' },
  { id: 'mine', label: '我的' },
  { id: 'pending', label: '待审' },
  { id: 'settings', label: '设置' }
];


const KEY = ['market'] as const;
function useMarketAction<T>(run: (input: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({ mutationFn: run, onSuccess: () => client.invalidateQueries({ queryKey: KEY }) });
}

export function MarketPage({ tab, reviewId }: { tab: MarketTab; reviewId: string | null }) {
  const account = useAccount();
  const pending = useQuery({ queryKey: [...KEY, 'reviews'], queryFn: marketApi.reviews, enabled: !!account });
  const installs = useQuery({ queryKey: [...KEY, 'install-requests'], queryFn: marketApi.installRequests, enabled: !!account });
  const waiting = (pending.data?.length ?? 0) + (installs.data?.toDecide.length ?? 0);
  if (!account) return null;
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-hair px-3 py-2">
        <div className="min-w-0">
          <a className="text-meta text-tertiary hover:text-accent" href={formatRoute({ page: 'home' })}>
            ← agent-hub
          </a>
          <h1 className="text-head text-primary">资产市场</h1>
        </div>
        <div className="flex items-center gap-2">
          <MessagesEntry />
        <NotificationBell />
          <AccountMenu />
        </div>
      </header>
      <nav aria-label="资产分页" className="flex gap-1 overflow-x-auto border-b border-hair px-2 py-1.5">
        {TABS.map((item) => (
          <a
            key={item.id}
            href={formatRoute({ page: 'assets', tab: item.id, reviewId: null })}
            aria-current={item.id === tab && !reviewId ? 'page' : undefined}
            className={`shrink-0 rounded-sm px-3 py-1.5 text-body ${item.id === tab && !reviewId ? 'bg-card text-primary' : 'text-secondary hover:bg-card'}`}
          >
            {item.label}
            {item.id === 'pending' && waiting > 0 ? (
              <span data-testid="pending-count" className="ml-1.5 rounded-full bg-accent px-1.5 text-[11px] text-canvas">
                {waiting}
              </span>
            ) : null}
          </a>
        ))}
      </nav>
      <main className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6">
        <div className="mx-auto max-w-[960px]">
          {reviewId ? (
            <ReviewPage submissionId={reviewId} />
          ) : tab === 'catalog' ? (
            <Catalog />
          ) : tab === 'mine' ? (
            <Mine />
          ) : tab === 'pending' ? (
            <Pending />
          ) : (
            <MarketSettings />
          )}
        </div>
      </main>
    </div>
  );
}

function ScopeBadge({ scope }: { scope: AssetScopeDto }) {
  return <span className="rounded-sm border border-hair px-1.5 text-[11px] text-tertiary">{SCOPE_TEXT[scope]}</span>;
}

function AssetCard({ item, showStatus }: { item: MarketAssetDto; showStatus: boolean }) {
  const [workers, setWorkers] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const account = useAccount();
  const sub = item.latestSubmission;
  return (
    <li data-testid="market-asset" className="border-b border-hair px-3 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-meta text-tertiary">{KIND_TEXT[item.asset.kind as AssetKindDto]}</span>
        <span className="min-w-0 break-all font-mono text-body text-primary">{item.asset.name}</span>
        <ScopeBadge scope={item.asset.scope} />
        {!item.published ? <span className="text-meta text-rust">未上架</span> : null}
      </div>
      <p className="mt-0.5 text-meta text-secondary">{item.asset.description || '（无描述）'}</p>
      <p className="mt-0.5 text-meta text-tertiary">
        作者 {item.owner} · 更新于 {at(item.asset.updatedAt)} · 装在 {item.workerIds.length} 台机器
      </p>
      {showStatus && sub ? (
        <p className="mt-1 text-meta">
          <a className="text-accent" href={formatRoute({ page: 'assets', tab: 'pending', reviewId: sub.id })}>
            最近提交：{STATUS_TEXT[sub.status]}
            {sub.targetScope ? `（申请提升为${SCOPE_TEXT[sub.targetScope]}）` : ''}
          </a>
          {sub.reason ? <span className="ml-1 text-secondary">— {sub.reason}</span> : null}
        </p>
      ) : null}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {item.published ? (
          <button className={SMALL} onClick={() => setWorkers(true)}>
            装到机器…
          </button>
        ) : null}
        {item.canMaintain ? <MaintainButtons item={item} /> : null}
        {account?.clusterAdmin && item.published && item.asset.scope !== 'personal' ? (
          <button className={DANGER} onClick={() => setRevoking(true)}>
            下架
          </button>
        ) : null}
      </div>
      {workers ? <WorkersDialog item={item} onClose={() => setWorkers(false)} /> : null}
      {revoking ? <RevokeDialog item={item} onClose={() => setRevoking(false)} /> : null}
    </li>
  );
}

function MaintainButtons({ item }: { item: MarketAssetDto }) {
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const revise = useMarketAction(async (files: PickedFile[]) => {
    const result = await marketApi.revision(item.asset.id, encodeFiles(files));
    setMessage(result.submissionId ? '新版本已提交审核' : '内容没变化');
  });
  const check = useMarketAction(async () => {
    const result = await marketApi.check(item.asset.id);
    setMessage(result.submissionId ? 'Git 有新提交，已转成待审提交（旧版本照常用）' : '已是最新');
  });
  const promote = useMarketAction(async () => {
    await marketApi.promote(item.asset.id);
    setMessage('已申请提升为全局，等 hub 管理员审核');
  });
  const error = revise.error ?? check.error ?? promote.error;
  return (
    <>
      {item.asset.source.type === 'git' ? (
        <button className={SMALL} disabled={check.isPending} onClick={() => check.mutate(undefined)}>
          检查 Git 更新
        </button>
      ) : (
        <>
          <button className={SMALL} onClick={() => input.current?.click()}>
            传新版本
          </button>
          <input
            ref={input}
            type="file"
            hidden
            multiple
            data-testid="revision-files"
            onChange={async (event) => {
              if (event.target.files?.length) revise.mutate(await readPicked(event.target.files));
            }}
          />
        </>
      )}
      {item.published && item.asset.scope !== 'global' && item.asset.scope !== 'personal' ? (
        <button className={SMALL} disabled={promote.isPending} onClick={() => promote.mutate(undefined)}>
          申请提升为全局
        </button>
      ) : null}
      {message || error ? (
        <span role="status" className={`basis-full text-meta ${error ? 'text-rust' : 'text-sage'}`}>
          {error ? errorText(error) : message}
        </span>
      ) : null}
    </>
  );
}

function WorkersDialog({ item, onClose }: { item: MarketAssetDto; onClose: () => void }) {
  const workers = useQuery({ queryKey: [...KEY, 'workers'], queryFn: marketApi.workers });
  const [note, setNote] = useState<string | null>(null);
  const toggle = useMarketAction(async ({ workerId, installed }: { workerId: string; installed: boolean }) => {
    const result = await marketApi.install(item.asset.id, workerId, installed);
    setNote(result.kind === 'requested' ? '这台机器不归你管：已向机器主人提交安装申请' : installed ? '已安装' : '已卸载');
  });
  return (
    <DialogShell title={`把 ${item.asset.name} 装到机器`} onClose={onClose}>
      {item.asset.scope === 'personal' ? <p className="mb-2 text-meta text-tertiary">个人资产只能装在你自己登记的机器上。</p> : null}
      {workers.isLoading ? <p className="text-meta text-tertiary">载入…</p> : null}
      <ul className="space-y-1">
        {(workers.data ?? []).map((worker) => {
          const installed = item.workerIds.includes(worker.workerId);
          return (
            <li key={worker.workerId} data-testid="market-worker" className="flex items-center gap-2 rounded-sm border border-hair px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate text-body text-primary">
                {worker.label}
                {worker.local ? <span className="ml-1 text-meta text-tertiary">（本机，仅 hub 管理员）</span> : null}
              </span>
              <button
                className={SMALL}
                disabled={toggle.isPending}
                onClick={() => toggle.mutate({ workerId: worker.workerId, installed: !installed })}
              >
                {installed ? '卸载' : worker.mode === 'request' ? '申请安装' : '安装'}
              </button>
            </li>
          );
        })}
      </ul>
      {!workers.isLoading && !workers.data?.length ? <p className="text-meta text-tertiary">没有你能用的机器。</p> : null}
      {note || toggle.error ? (
        <p role="status" className={`mt-2 text-meta ${toggle.error ? 'text-rust' : 'text-sage'}`}>
          {toggle.error ? errorText(toggle.error) : note}
        </p>
      ) : null}
    </DialogShell>
  );
}

function RevokeDialog({ item, onClose }: { item: MarketAssetDto; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const revoke = useMarketAction(() => marketApi.revoke(item.asset.id, reason.trim()));
  return (
    <DialogShell title={`下架 ${item.asset.name}`} onClose={onClose}>
      <p className="mb-2 text-meta text-tertiary">下架后从所有机器卸掉，作者会收到通知。</p>
      <textarea className={`${INPUT} min-h-[80px]`} placeholder="原因（必填）" value={reason} onChange={(e) => setReason(e.target.value)} />
      {revoke.error ? <p className="mt-1 text-meta text-rust">{errorText(revoke.error)}</p> : null}
      <div className="mt-2 flex justify-end">
        <button className={PRIMARY_BUTTON} disabled={!reason.trim() || revoke.isPending} onClick={() => revoke.mutate(undefined, { onSuccess: onClose })}>
          下架
        </button>
      </div>
    </DialogShell>
  );
}

function Catalog() {
  const catalog = useQuery({ queryKey: [...KEY, 'catalog'], queryFn: marketApi.catalog });
  const [query, setQuery] = useState('');
  const shown = (catalog.data ?? []).filter((item) => `${item.asset.name} ${item.asset.description}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <Section title="已上架的资产" aside={<SubmitButton />}>
      <input className={`${INPUT} mb-2`} placeholder="搜索名字或描述" value={query} onChange={(e) => setQuery(e.target.value)} />
      <Panel>
        {catalog.error ? <p className="px-3 py-2 text-meta text-rust">{errorText(catalog.error)}</p> : null}
        <ul>{shown.map((item) => <AssetCard key={item.asset.id} item={item} showStatus={false} />)}</ul>
        {catalog.data && !shown.length ? <Empty text="还没有上架的资产" /> : null}
      </Panel>
    </Section>
  );
}

function Mine() {
  const mine = useQuery({ queryKey: [...KEY, 'mine'], queryFn: marketApi.mine });
  const requests = useQuery({ queryKey: [...KEY, 'install-requests'], queryFn: marketApi.installRequests });
  return (
    <>
      <Section title="我上架的" aside={<SubmitButton />}>
        <Panel>
          <ul>{(mine.data ?? []).map((item) => <AssetCard key={item.asset.id} item={item} showStatus />)}</ul>
          {mine.data && !mine.data.length ? <Empty text="还没上架过资产。点「提交资产」开始。" /> : null}
        </Panel>
      </Section>
      {requests.data?.mine.length ? (
        <Section title="我的安装申请">
          <Panel>
            <ul>
              {requests.data.mine.map((r) => (
                <li key={r.id} className="border-b border-hair px-3 py-2 text-meta last:border-b-0">
                  <span className="text-primary">{r.asset}</span> → {r.workerId} · {STATUS_TEXT[r.status] ?? r.status}
                  {r.reason ? ` — ${r.reason}` : ''}
                </li>
              ))}
            </ul>
          </Panel>
        </Section>
      ) : null}
    </>
  );
}

function Pending() {
  const reviews = useQuery({ queryKey: [...KEY, 'reviews'], queryFn: marketApi.reviews });
  const requests = useQuery({ queryKey: [...KEY, 'install-requests'], queryFn: marketApi.installRequests });
  const decide = useMarketAction(({ id, approve }: { id: string; approve: boolean }) => marketApi.decideInstall(id, approve));
  return (
    <>
      <Section title="等我审核">
        <Panel>
          <ul>
            {(reviews.data ?? []).map(({ submission, asset, submitter, routedToHub }) => (
              <li key={submission.id} data-testid="review-item" className="border-b border-hair last:border-b-0">
                <a className="block px-3 py-2.5 hover:bg-card" href={formatRoute({ page: 'assets', tab: 'pending', reviewId: submission.id })}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-body text-primary">{asset.name}</span>
                    <ScopeBadge scope={submission.targetScope ?? asset.scope} />
                    {submission.report.findings.some((f) => f.level === 'high') ? <span className="text-meta text-rust">有高风险项</span> : null}
                    {routedToHub ? <span className="text-meta text-tertiary">转给 hub 管理员</span> : null}
                  </div>
                  <p className="text-meta text-tertiary">
                    {submitter} 提交于 {at(submission.createdAt)} · {submission.previous ? '新版本' : '首次上架'} · 需 {submission.required} 人通过，已 {submission.approvals.length}
                  </p>
                </a>
              </li>
            ))}
          </ul>
          {reviews.data && !reviews.data.length ? <Empty text="没有等你审核的提交" /> : null}
        </Panel>
      </Section>
      <Section title="安装申请（装到我管的机器）">
        <Panel>
          <ul>
            {(requests.data?.toDecide ?? []).map((r) => (
              <li key={r.id} data-testid="install-request" className="flex flex-wrap items-center gap-2 border-b border-hair px-3 py-2 last:border-b-0">
                <span className="min-w-0 flex-1 text-meta text-secondary">
                  {r.requester} 想把 <span className="text-primary">{r.asset}</span> 装到 {r.workerId}
                </span>
                <button className={SMALL} disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: true })}>
                  批准
                </button>
                <button className={DANGER} disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: false })}>
                  拒绝
                </button>
              </li>
            ))}
          </ul>
          {requests.data && !requests.data.toDecide.length ? <Empty text="没有待批的安装申请" /> : null}
          {decide.error ? <p className="px-3 py-2 text-meta text-rust">{errorText(decide.error)}</p> : null}
        </Panel>
      </Section>
    </>
  );
}

function SubmitButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button data-testid="market-submit" className={SMALL} onClick={() => setOpen(true)}>
        提交资产
      </button>
      {open ? <SubmitDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SubmitDialog({ onClose }: { onClose: () => void }) {
  const account = useAccount();
  const [kind, setKind] = useState<AssetKindDto>('skill');
  const [scope, setScope] = useState<AssetScopeDto>('personal');
  const [from, setFrom] = useState<'upload' | 'git'>('upload');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [git, setGit] = useState({ url: '', ref: '', path: '' });
  const [done, setDone] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const submit = useMarketAction(async () => {
    const result =
      from === 'git'
        ? await marketApi.git({ kind, scope, url: git.url.trim(), ref: git.ref.trim() || null, path: git.path.trim() })
        : await marketApi.upload({
            kind,
            scope,
            name: name.trim() || null,
            files: encodeFiles(
              kind === 'mcp'
                ? [{ path: 'mcp.json', bytes: new TextEncoder().encode(text) }]
                : kind === 'instruction' && text.trim()
                  ? [{ path: `${name || 'instruction'}.md`, bytes: new TextEncoder().encode(text) }]
                  : files
            )
          });
    setDone(result.status === 'approved' ? '已上架（个人资产不用审核）' : '已提交，等审核人审核；结果会通知你');
  });
  const ready =
    from === 'git'
      ? git.url.trim() !== ''
      : kind === 'skill'
        ? files.some((f) => f.path === 'SKILL.md')
        : kind === 'mcp'
          ? text.trim() !== ''
          : /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && text.trim() !== '';
  const scopes: AssetScopeDto[] = account?.clusterAdmin ? ['personal', 'team', 'global'] : ['personal', 'team'];
  return (
    <DialogShell title="提交资产" onClose={onClose}>
      {done ? (
        <div className="space-y-3">
          <p role="status" data-testid="submit-done" className="text-body text-sage">
            {done}
          </p>
          <div className="flex justify-end">
            <button className={PRIMARY_BUTTON} onClick={onClose}>
              好
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Choice value={kind} onChange={setKind} options={[['skill', '技能'], ['instruction', '指令'], ['mcp', 'MCP']]} label="类型" />
          <Choice value={scope} onChange={setScope} options={scopes.map((s) => [s, SCOPE_TEXT[s]] as [AssetScopeDto, string])} label="作用域" />
          <p className="text-meta text-tertiary">
            {scope === 'personal'
              ? '个人资产：只有你能用，只能装在你自己的机器上，不用审核。'
              : scope === 'team'
                ? '团队资产：团队负责人或指定审核人批准后上架（不能自己批自己的）。'
                : '全局资产：所有人可见。'}
          </p>
          <Choice value={from} onChange={setFrom} options={[['upload', '上传'], ['git', '从 Git']]} label="来源" />
          {from === 'git' ? (
            <>
              <input className={INPUT} placeholder="仓库地址 https://…" value={git.url} onChange={(e) => setGit({ ...git, url: e.target.value })} />
              <div className="flex gap-2">
                <input className={INPUT} placeholder="分支 / tag（默认分支）" value={git.ref} onChange={(e) => setGit({ ...git, ref: e.target.value })} />
                <input className={INPUT} placeholder="子目录 / 文件" value={git.path} onChange={(e) => setGit({ ...git, path: e.target.value })} />
              </div>
            </>
          ) : kind === 'skill' ? (
            <>
              <button className={SECONDARY_BUTTON} onClick={() => input.current?.click()}>
                选文件 / zip（根目录要有 SKILL.md）
              </button>
              <input
                ref={input}
                data-testid="market-files"
                type="file"
                hidden
                multiple
                onChange={async (e) => {
                  if (e.target.files?.length) setFiles(await readPicked(e.target.files));
                }}
              />
              {files.length ? <p className="text-meta text-secondary">{files.map((f) => f.path).join('、')}</p> : null}
            </>
          ) : (
            <>
              {kind === 'instruction' ? (
                <input className={INPUT} placeholder="名字：小写字母、数字、-" value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} />
              ) : null}
              <textarea
                data-testid="market-text"
                className={`${INPUT} min-h-[140px] font-mono text-meta`}
                placeholder={kind === 'mcp' ? '{ "name": "…", "command": "…", "args": [] }' : '指令内容（Markdown）'}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </>
          )}
          {submit.error ? (
            <p role="alert" className="text-meta text-rust">
              {errorText(submit.error)}
            </p>
          ) : null}
          <div className="flex justify-end">
            <button data-testid="market-submit-go" className={PRIMARY_BUTTON} disabled={!ready || submit.isPending} onClick={() => submit.mutate(undefined)}>
              {submit.isPending ? '提交中…' : scope === 'personal' ? '上架' : '提交审核'}
            </button>
          </div>
        </div>
      )}
    </DialogShell>
  );
}

function Choice<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: [T, string][]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {options.map(([id, text]) => (
        <button
          key={id}
          role="radio"
          aria-checked={id === value}
          className={`rounded-sm border px-2.5 py-1 text-meta ${id === value ? 'border-accent text-accent' : 'border-hair text-secondary'}`}
          onClick={() => onChange(id)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function MarketSettings() {
  const settings = useQuery({ queryKey: [...KEY, 'settings'], queryFn: marketApi.settings });
  const team = useQuery({ queryKey: [...KEY, 'team'], queryFn: teamApi.team });
  return (
    <>
      {settings.data?.team ? (
        <ReviewSettingsForm
          title="团队资产审核"
          target="team"
          value={settings.data.team}
          editable={settings.data.team.editable}
          candidates={(team.data?.members ?? []).filter((m) => !m.teamOwner && !m.disabled)}
          showGlobal={false}
        />
      ) : null}
      {settings.data?.hub ? (
        <ReviewSettingsForm
          title="全局资产审核（hub）"
          target="hub"
          value={settings.data.hub}
          editable
          candidates={(team.data?.members ?? []).filter((m) => !m.disabled && m.email !== '')}
          showGlobal
        />
      ) : null}
      <ScopedSecrets />
    </>
  );
}

function ReviewSettingsForm({
  title,
  target,
  value,
  editable,
  candidates,
  showGlobal
}: {
  title: string;
  target: 'team' | 'hub';
  value: { reviewers: readonly string[]; twoReviewers: { global: boolean; mcpStdio: boolean } };
  editable: boolean;
  candidates: { id: string; displayName: string; email: string }[];
  showGlobal: boolean;
}) {
  const account = useAccount();
  const [reviewers, setReviewers] = useState<string[]>([...value.reviewers]);
  const [two, setTwo] = useState(value.twoReviewers);
  const save = useMarketAction(() => marketApi.saveSettings(target, reviewers, two));
  const shown = candidates.filter((c) => c.id !== account?.id);
  return (
    <Section title={title}>
      <Panel>
        <div className="space-y-2 px-3 py-2.5">
          <p className="text-meta text-tertiary">
            {target === 'team' ? '团队负责人始终是审核人；在这里再指定几位成员。' : 'hub 管理员始终是审核人；可再指定几位第二审核人。'}
          </p>
          <ul className="space-y-1">
            {shown.map((m) => (
              <li key={m.id}>
                <label className="flex items-center gap-2 text-meta text-secondary">
                  <input
                    type="checkbox"
                    disabled={!editable}
                    checked={reviewers.includes(m.id)}
                    onChange={() => setReviewers((list) => (list.includes(m.id) ? list.filter((id) => id !== m.id) : [...list, m.id]))}
                  />
                  {m.displayName || m.email} <span className="text-tertiary">{m.email}</span>
                </label>
              </li>
            ))}
          </ul>
          {!shown.length ? <p className="text-meta text-tertiary">没有可指定的成员。</p> : null}
          {showGlobal ? (
            <label className="flex items-center gap-2 text-meta text-secondary">
              <input type="checkbox" disabled={!editable} checked={two.global} onChange={() => setTwo({ ...two, global: !two.global })} />
              全局资产要两人通过
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-meta text-secondary">
            <input type="checkbox" disabled={!editable} checked={two.mcpStdio} onChange={() => setTwo({ ...two, mcpStdio: !two.mcpStdio })} />
            stdio MCP 要两人通过
          </label>
          <p className="text-meta text-tertiary">审核人不够两位时自动降到一位，并在审计里记一笔。</p>
          {save.error ? <p className="text-meta text-rust">{errorText(save.error)}</p> : null}
          {save.isSuccess ? <p className="text-meta text-sage">已保存</p> : null}
          {editable ? (
            <div className="flex justify-end">
              <button className={SMALL} disabled={save.isPending} onClick={() => save.mutate(undefined)}>
                保存
              </button>
            </div>
          ) : (
            <p className="text-meta text-tertiary">只有{target === 'team' ? '团队负责人' : ' hub 管理员'}能改。</p>
          )}
        </div>
      </Panel>
    </Section>
  );
}

function ScopedSecrets() {
  const secrets = useQuery({ queryKey: [...KEY, 'secrets'], queryFn: marketApi.secrets });
  const [layer, setLayer] = useState<'personal' | 'team'>('personal');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const set = useMarketAction(() => marketApi.setSecret(layer, name.trim(), value));
  const remove = useMarketAction(({ l, n }: { l: 'personal' | 'team'; n: string }) => marketApi.removeSecret(l, n));
  const rows = [
    ...(secrets.data?.personal ?? []).map((s) => ({ ...s, layer: 'personal' as const })),
    ...(secrets.data?.team ?? []).map((s) => ({ ...s, layer: 'team' as const }))
  ];
  return (
    <Section title="MCP 密钥（个人 / 团队）">
      <Panel>
        <p className="px-3 pt-2 text-meta text-tertiary">
          {'${secret:NAME}'} 运行时按 个人 → 团队 → hub 的顺序取。值写进去就读不回来。
        </p>
        <ul>
          {rows.map((s) => (
            <li key={`${s.layer}:${s.name}`} className="flex items-center gap-2 border-b border-hair px-3 py-1.5 text-meta last:border-b-0">
              <span className="min-w-0 flex-1 truncate font-mono text-primary">{s.name}</span>
              <span className="text-tertiary">{s.layer === 'team' ? '团队' : '个人'}</span>
              {s.layer === 'personal' || secrets.data?.teamEditable ? (
                <button className={DANGER} onClick={() => remove.mutate({ l: s.layer, n: s.name })}>
                  删除
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2 px-3 py-2">
          {secrets.data?.teamEditable ? (
            <select className={`${INPUT} w-auto`} value={layer} onChange={(e) => setLayer(e.target.value as 'personal' | 'team')}>
              <option value="personal">个人</option>
              <option value="team">团队</option>
            </select>
          ) : null}
          <input className={`${INPUT} min-w-0 flex-1`} placeholder="NAME" value={name} onChange={(e) => setName(e.target.value.toUpperCase())} />
          <input className={`${INPUT} min-w-0 flex-1`} type="password" placeholder="值" value={value} onChange={(e) => setValue(e.target.value)} />
          <button
            className={SMALL}
            disabled={!name.trim() || !value || set.isPending}
            onClick={() => set.mutate(undefined, { onSuccess: () => { setName(''); setValue(''); } })}
          >
            保存
          </button>
        </div>
        {set.error || remove.error ? <p className="px-3 pb-2 text-meta text-rust">{errorText(set.error ?? remove.error)}</p> : null}
      </Panel>
    </Section>
  );
}
