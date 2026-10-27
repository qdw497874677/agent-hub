import { useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { assetsApi } from '../api.ts';
import type { AssetsOverviewDto, GitScanDto } from '../api.ts';
import { DialogShell, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../dialog-shell.tsx';
import { INPUT, SMALL, DANGER, at, errorText, Section, Panel, Empty, useAdminAction } from './shared.tsx';
import { encodeFiles, formatBytes, readPicked, type PickedFile } from './asset-files.ts';

/**
 * 资产中心：技能（SKILL.md）和指令，钉在不可变版本上，按机器安装。
 * 机器把它们同步进自己的 ~/.agent-hub/assets，只对之后新开的会话生效；从不碰机器上原有的技能目录。
 */
type Asset = AssetsOverviewDto['assets'][number];
type WorkerRow = AssetsOverviewDto['workers'][number];
type Kind = 'skill' | 'instruction';

const KIND_TEXT: Record<Kind, string> = { skill: '技能', instruction: '指令' };
const short = (digest: string) => digest.slice(0, 8);
const sourceText = (asset: Asset) =>
  asset.source.type === 'git'
    ? `${asset.source.url.replace(/^https?:\/\//, '')}${asset.source.ref ? `@${asset.source.ref}` : ''}${asset.source.path ? ` · ${asset.source.path}` : ''}`
    : '上传';

function syncText(worker: WorkerRow): { text: string; tone: 'ok' | 'busy' | 'bad' | 'idle' } {
  const sync = worker.sync;
  if (worker.state !== 'online') return { text: worker.assetIds.length ? '离线 · 上线后同步' : '离线', tone: 'idle' };
  if (!sync) return { text: worker.assetIds.length ? '等待同步' : '未装资产', tone: 'idle' };
  if (sync.state === 'failed') return { text: `同步失败：${sync.error ?? '未知原因'}`, tone: 'bad' };
  if (sync.state === 'syncing' || sync.state === 'pending') return { text: '同步中…', tone: 'busy' };
  const count = Object.keys(sync.installed).length;
  return { text: count ? `已同步 ${count} 项 · ${at(sync.at)}` : `已清空 · ${at(sync.at)}`, tone: 'ok' };
}

const TONE: Record<string, string> = {
  ok: 'bg-sage',
  busy: 'bg-accent animate-pulse',
  bad: 'bg-rust',
  idle: 'bg-card-raised border border-strong'
};

export function Assets() {
  const overview = useQuery({
    queryKey: ['admin', 'assets'],
    queryFn: assetsApi.overview,
    refetchInterval: (query) =>
      query.state.data?.workers.some((worker) => worker.sync?.state === 'syncing' || worker.sync?.state === 'pending')
        ? 1_500
        : 8_000
  });
  const [adding, setAdding] = useState(false);
  const [diffing, setDiffing] = useState<Asset | null>(null);
  const [browsing, setBrowsing] = useState<Asset | null>(null);
  const assets = overview.data?.assets ?? [];
  const workers = overview.data?.workers ?? [];
  return (
    <>
      <Section
        title="资产"
        aside={
          <button data-testid="asset-add" className={PRIMARY_BUTTON} onClick={() => setAdding(true)}>
            添加
          </button>
        }
      >
        <p className="mb-3 text-meta text-tertiary">
          技能和指令按机器安装，装进那台机器的 <code>~/.agent-hub/assets</code>，之后新开的会话就能用。版本不可变，升级前先看差异。
        </p>
        <Panel>
          {assets.length ? (
            <ul>
              {assets.map((asset) => (
                <AssetItem
                  key={asset.id}
                  asset={asset}
                  workers={workers}
                  onDiff={() => setDiffing(asset)}
                  onBrowse={() => setBrowsing(asset)}
                />
              ))}
            </ul>
          ) : (
            <Empty text={overview.isLoading ? '载入中…' : '还没有资产。点「添加」上传技能文件夹 / zip，或从 Git 导入。'} />
          )}
        </Panel>
      </Section>
      <Section title="机器同步" aside={<span className="text-meta text-tertiary">{workers.length} 台</span>}>
        <Panel>
          {workers.length ? (
            <ul>
              {workers.map((worker) => {
                const status = syncText(worker);
                return (
                  <li
                    key={worker.workerId}
                    data-testid="asset-sync"
                    className="flex items-start gap-2 border-b border-hair px-3 py-2.5 last:border-b-0"
                  >
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE[status.tone]}`} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body text-primary">{worker.label}</p>
                      <p className={`break-words text-meta ${status.tone === 'bad' ? 'text-rust' : 'text-tertiary'}`}>
                        {worker.assetIds.length} 项已分配 · {status.text}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty text="还没有机器" />
          )}
        </Panel>
      </Section>
      {adding ? <AddDialog onClose={() => setAdding(false)} /> : null}
      {diffing ? <DiffDialog asset={diffing} onClose={() => setDiffing(null)} /> : null}
      {browsing ? <VersionsDialog asset={browsing} onClose={() => setBrowsing(null)} /> : null}
    </>
  );
}

function AssetItem({
  asset,
  workers,
  onDiff,
  onBrowse
}: {
  asset: Asset;
  workers: readonly WorkerRow[];
  onDiff: () => void;
  onBrowse: () => void;
}) {
  const upload = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const install = useAdminAction((input: { workerId: string; installed: boolean }) =>
    assetsApi.install(asset.id, input.workerId, input.installed)
  );
  const refresh = useAdminAction(async (files?: PickedFile[]) => {
    const result = files ? await assetsApi.uploadRevision(asset.id, encodeFiles(files)) : await assetsApi.check(asset.id);
    setNote(result.changed ? '有新版本，确认后才会升级' : '没有变化');
    return result;
  });
  const remove = useAdminAction(() => assetsApi.remove(asset.id));
  const upgradable = asset.latest !== asset.pinned;
  const error = install.error ?? refresh.error ?? remove.error;
  return (
    <li data-testid="asset-item" data-name={asset.name} className="border-b border-hair px-3 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-strong px-1.5 text-meta text-secondary">{KIND_TEXT[asset.kind]}</span>
        <span className="min-w-0 truncate text-body font-medium text-primary">{asset.name}</span>
        {upgradable ? (
          <button
            data-testid="asset-upgrade"
            className="rounded border border-accent px-1.5 text-meta text-accent hover:bg-accent hover:text-canvas"
            onClick={onDiff}
          >
            有新版本 · 查看并升级
          </button>
        ) : null}
      </div>
      {asset.description ? <p className="mt-0.5 line-clamp-2 text-sub text-secondary">{asset.description}</p> : null}
      <p className="mt-0.5 break-all text-meta text-tertiary">
        {sourceText(asset)} · 版本 <code>{short(asset.pinned)}</code> · {asset.files} 个文件 · {formatBytes(asset.bytes)} ·{' '}
        {at(asset.updatedAt)}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`${asset.name} 装到哪些机器`}>
        {workers.map((worker) => {
          const on = asset.workerIds.includes(worker.workerId);
          const synced = worker.sync?.installed[asset.id] === asset.pinned;
          return (
            <button
              key={worker.workerId}
              data-testid="asset-worker"
              aria-pressed={on}
              disabled={install.isPending}
              title={on ? (synced ? '已同步到这台机器；点一下卸载' : '已分配，等待同步；点一下卸载') : '点一下装到这台机器'}
              className={`flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-meta transition-colors ${
                on ? 'border-accent bg-accent/10 text-primary' : 'border-hair text-tertiary hover:border-strong hover:text-secondary'
              } ${worker.state === 'online' ? '' : 'opacity-60'}`}
              onClick={() => install.mutate({ workerId: worker.workerId, installed: !on })}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${on ? (synced ? 'bg-sage' : 'bg-accent animate-pulse') : 'bg-strong'}`}
              />
              <span className="truncate">{worker.label}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className={SMALL} onClick={onBrowse}>
          版本与文件
        </button>
        {asset.source.type === 'git' ? (
          <button
            data-testid="asset-check"
            className={SMALL}
            disabled={refresh.isPending}
            onClick={() => refresh.mutate(undefined)}
          >
            {refresh.isPending ? '检查中…' : '检查更新'}
          </button>
        ) : (
          <>
            <button className={SMALL} disabled={refresh.isPending} onClick={() => upload.current?.click()}>
              {refresh.isPending ? '上传中…' : '上传新版本'}
            </button>
            <input
              ref={upload}
              data-testid="asset-revision-files"
              type="file"
              multiple
              hidden
              accept={asset.kind === 'instruction' ? '.md,.markdown,.txt' : undefined}
              onChange={async (event) => {
                const list = event.target.files;
                if (list?.length) refresh.mutate(await readPicked(list));
                event.target.value = '';
              }}
            />
          </>
        )}
        {note ? <span className="text-meta text-tertiary">{note}</span> : null}
        <span className="flex-1" />
        <button
          className={DANGER}
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`删除「${asset.name}」？已装的机器会在下次同步时把它移除。`)) remove.mutate(undefined);
          }}
        >
          删除
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-meta text-rust">
          {errorText(error)}
        </p>
      ) : null}
    </li>
  );
}

/* ── 添加：上传（文件 / 文件夹 / zip / 粘贴）或 Git ── */

function Tabs<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="mb-3 flex rounded-sm border border-hair p-0.5" role="tablist">
      {options.map(([id, label]) => (
        <button
          key={id}
          role="tab"
          aria-selected={value === id}
          className={`flex-1 rounded-sm px-2 py-1 text-sub ${value === id ? 'bg-card-raised text-primary' : 'text-tertiary hover:text-secondary'}`}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function AddDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'upload' | 'git'>('upload');
  return (
    <DialogShell title="添加资产" onClose={onClose}>
      <h2 className="mb-3 text-head text-primary">添加资产</h2>
      <Tabs
        value={mode}
        onChange={setMode}
        options={[
          ['upload', '上传'],
          ['git', '从 Git 导入']
        ]}
      />
      {mode === 'upload' ? <UploadForm onDone={onClose} /> : <GitForm onDone={onClose} />}
    </DialogShell>
  );
}

function UploadForm({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState<Kind>('skill');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [readError, setReadError] = useState<string | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const create = useAdminAction(() => {
    const picked =
      kind === 'instruction' && text.trim()
        ? [{ path: `${name || 'instruction'}.md`, bytes: new TextEncoder().encode(text) }]
        : files;
    return assetsApi.upload({ kind, name: name.trim() || undefined, files: encodeFiles(picked) });
  });
  const pick = async (list: FileList | null) => {
    setReadError(null);
    if (!list?.length) return;
    try {
      setFiles(await readPicked(list));
    } catch (error) {
      setReadError(`读不了这些文件：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const hasSkillMd = files.some((file) => file.path === 'SKILL.md');
  const ready =
    kind === 'skill' ? files.length > 0 && hasSkillMd : /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && (text.trim() !== '' || files.length === 1);
  return (
    <div className="space-y-3">
      <Tabs
        value={kind}
        onChange={(value) => {
          setKind(value);
          setFiles([]);
        }}
        options={[
          ['skill', '技能（SKILL.md）'],
          ['instruction', '指令（一段 Markdown）']
        ]}
      />
      {kind === 'instruction' ? (
        <>
          <input
            className={INPUT}
            placeholder="名字：小写字母、数字、-，如 house-rules"
            value={name}
            onChange={(event) => setName(event.target.value.trim().toLowerCase())}
          />
          <textarea
            data-testid="asset-text"
            className={`${INPUT} min-h-[140px] font-mono text-meta`}
            placeholder="直接粘贴指令内容，或在下面选一个 .md 文件"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </>
      ) : (
        <p className="text-meta text-tertiary">选整个技能文件夹，或它的 zip，或多选文件；根目录要有 SKILL.md（name / description 写在 frontmatter）。</p>
      )}
      <div className="flex flex-wrap gap-2">
        <button className={SECONDARY_BUTTON} onClick={() => filesInput.current?.click()}>
          {kind === 'skill' ? '选文件 / zip' : '选 .md 文件'}
        </button>
        {kind === 'skill' ? (
          <button className={SECONDARY_BUTTON} onClick={() => folderInput.current?.click()}>
            选文件夹
          </button>
        ) : null}
        <input
          ref={filesInput}
          data-testid="asset-files"
          type="file"
          hidden
          multiple={kind === 'skill'}
          accept={kind === 'instruction' ? '.md,.markdown,.txt' : undefined}
          onChange={(event) => void pick(event.target.files)}
        />
        <input
          ref={folderInput}
          type="file"
          hidden
          multiple
          {...({ webkitdirectory: '' } as Record<string, string>)}
          onChange={(event) => void pick(event.target.files)}
        />
      </div>
      {files.length ? (
        <ul className="max-h-[140px] overflow-auto rounded-sm border border-hair bg-card px-2.5 py-1.5 text-meta text-secondary">
          {files.map((file) => (
            <li key={file.path} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
              <span className="text-tertiary">{formatBytes(file.bytes.length)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {kind === 'skill' && files.length > 0 && !hasSkillMd ? (
        <p className="text-meta text-rust">根目录没有 SKILL.md</p>
      ) : null}
      {readError || create.error ? (
        <p role="alert" className="text-meta text-rust">
          {readError ?? errorText(create.error)}
        </p>
      ) : null}
      <div className="flex justify-end">
        <button
          data-testid="asset-upload"
          className={PRIMARY_BUTTON}
          disabled={!ready || create.isPending}
          onClick={() => create.mutate(undefined, { onSuccess: onDone })}
        >
          {create.isPending ? '上传中…' : '添加'}
        </button>
      </div>
    </div>
  );
}

function GitForm({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [scan, setScan] = useState<GitScanDto | null>(null);
  const [choice, setChoice] = useState<number>(0);
  const scanning = useAdminAction(async () => {
    const result = await assetsApi.scanGit(url.trim(), ref.trim());
    setScan(result);
    setChoice(0);
    return result;
  });
  const importing = useAdminAction(() => {
    const candidate = scan!.candidates[choice]!;
    return assetsApi.importGit({ url: url.trim(), ref: ref.trim(), kind: candidate.kind, path: candidate.path });
  });
  const error = scanning.error ?? importing.error;
  return (
    <div className="space-y-3">
      <input
        data-testid="asset-git-url"
        className={INPUT}
        placeholder="https://github.com/owner/repo"
        value={url}
        onChange={(event) => {
          setUrl(event.target.value);
          setScan(null);
        }}
      />
      <div className="flex gap-2">
        <input
          className={INPUT}
          placeholder="分支 / tag（可空，默认分支）"
          value={ref}
          onChange={(event) => {
            setRef(event.target.value);
            setScan(null);
          }}
        />
        <button
          data-testid="asset-git-scan"
          className={SECONDARY_BUTTON}
          disabled={!url.trim() || scanning.isPending}
          onClick={() => scanning.mutate(undefined)}
        >
          {scanning.isPending ? '扫描中…' : '扫描'}
        </button>
      </div>
      <p className="text-meta text-tertiary">只读拉取公开仓库，不执行任何脚本；导入会钉在当前提交上。</p>
      {scan ? (
        scan.candidates.length ? (
          <ul className="max-h-[220px] overflow-auto rounded-sm border border-hair bg-card">
            {scan.candidates.map((candidate, index) => (
              <li key={`${candidate.kind}:${candidate.path}`} className="border-b border-hair last:border-b-0">
                <label className="flex cursor-pointer items-start gap-2 px-2.5 py-2">
                  <input
                    type="radio"
                    name="git-candidate"
                    className="mt-1 accent-[var(--color-accent)]"
                    checked={choice === index}
                    onChange={() => setChoice(index)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sub text-primary">
                      {KIND_TEXT[candidate.kind]} · {candidate.name}
                    </span>
                    <span className="block truncate text-meta text-tertiary">{candidate.path || '（仓库根目录）'}</span>
                    {candidate.description ? (
                      <span className="line-clamp-2 block text-meta text-secondary">{candidate.description}</span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-meta text-tertiary">这个提交（{short(scan.commit)}）里没找到 SKILL.md。</p>
        )
      ) : null}
      {error ? (
        <p role="alert" className="text-meta text-rust">
          {errorText(error)}
        </p>
      ) : null}
      <div className="flex justify-end">
        <button
          data-testid="asset-git-import"
          className={PRIMARY_BUTTON}
          disabled={!scan?.candidates.length || importing.isPending}
          onClick={() => importing.mutate(undefined, { onSuccess: onDone })}
        >
          {importing.isPending ? '导入中…' : '导入'}
        </button>
      </div>
    </div>
  );
}

/* ── 差异与升级 ── */

function Patch({ patch }: { patch: string }) {
  return (
    <pre className="overflow-x-auto whitespace-pre font-mono text-[12px] leading-[1.45]">
      {patch.split('\n').map((line, index) => (
        <div
          key={index}
          className={
            line.startsWith('+') && !line.startsWith('+++')
              ? 'bg-sage/15 text-primary'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'bg-rust/20 text-secondary'
                : line.startsWith('@@')
                  ? 'text-accent-dim'
                  : 'text-tertiary'
          }
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

const CHANGE_TEXT = { added: '新增', removed: '删除', modified: '修改', unchanged: '未变' } as const;

function DiffBody({ asset, from, to }: { asset: Asset; from: string; to: string }) {
  const diff = useQuery({ queryKey: ['admin', 'assets', asset.id, 'diff', from, to], queryFn: () => assetsApi.diff(asset.id, from, to) });
  const changed = (diff.data?.files ?? []).filter((file) => file.change !== 'unchanged');
  if (diff.isLoading) return <p className="text-meta text-tertiary">载入差异…</p>;
  if (diff.error) return <p className="text-meta text-rust">{errorText(diff.error)}</p>;
  if (!changed.length) return <p className="text-meta text-tertiary">内容没有变化。</p>;
  return (
    <div className="space-y-2">
      {changed.map((file) => (
        <details key={file.path} open={changed.length <= 4} className="rounded-sm border border-hair bg-card">
          <summary className="cursor-pointer px-2.5 py-1.5 text-sub text-primary">
            <span className="mr-2 text-meta text-tertiary">{CHANGE_TEXT[file.change]}</span>
            <span className="font-mono">{file.path}</span>
          </summary>
          <div className="border-t border-hair px-2.5 py-1.5">
            {file.patch ? <Patch patch={file.patch} /> : <p className="text-meta text-tertiary">二进制或过大，不显示内容</p>}
          </div>
        </details>
      ))}
    </div>
  );
}

function DiffDialog({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const pin = useAdminAction(() => assetsApi.pin(asset.id, asset.latest));
  return (
    <DialogShell title={`升级 ${asset.name}`} onClose={onClose} wide>
      <h2 className="text-head text-primary">升级「{asset.name}」</h2>
      <p className="mb-3 text-meta text-tertiary">
        <code>{short(asset.pinned)}</code> → <code>{short(asset.latest)}</code> · 确认后，已装的 {asset.workerIds.length}{' '}
        台机器会同步到新版本（只影响之后新开的会话）。
      </p>
      <div className="min-h-0 flex-1 overflow-auto" data-testid="asset-diff">
        <DiffBody asset={asset} from={asset.pinned} to={asset.latest} />
      </div>
      {pin.error ? (
        <p role="alert" className="mt-2 text-meta text-rust">
          {errorText(pin.error)}
        </p>
      ) : null}
      <div className="mt-3 flex justify-end gap-2">
        <button className={SECONDARY_BUTTON} onClick={onClose}>
          先不升级
        </button>
        <button
          data-testid="asset-pin"
          className={PRIMARY_BUTTON}
          disabled={pin.isPending}
          onClick={() => pin.mutate(undefined, { onSuccess: onClose })}
        >
          {pin.isPending ? '升级中…' : '确认升级'}
        </button>
      </div>
    </DialogShell>
  );
}

/* ── 版本与文件 ── */

function VersionsDialog({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const revisions = useQuery({ queryKey: ['admin', 'assets', asset.id, 'revisions'], queryFn: () => assetsApi.revisions(asset.id) });
  const [digest, setDigest] = useState(asset.pinned);
  const list = revisions.data ?? [];
  const current = list.find((revision) => revision.digest === digest);
  const [path, setPath] = useState<string | null>(null);
  const shown = path ?? current?.files.find((file) => /(^|\/)SKILL\.md$|\.md$/.test(file.path))?.path ?? current?.files[0]?.path ?? null;
  const index = list.findIndex((revision) => revision.digest === digest);
  const previous = index >= 0 ? list[index + 1] : undefined;
  const [view, setView] = useState<'files' | 'diff'>('files');
  const pin = useAdminAction((target: string) => assetsApi.pin(asset.id, target));
  return (
    <DialogShell title={`${asset.name} 的版本`} onClose={onClose} wide>
      <h2 className="mb-2 text-head text-primary">{asset.name} · 版本</h2>
      <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
        {list.map((revision) => (
          <button
            key={revision.digest}
            className={`shrink-0 rounded-sm border px-2 py-1 text-left text-meta ${
              revision.digest === digest ? 'border-accent text-primary' : 'border-hair text-tertiary hover:border-strong'
            }`}
            onClick={() => {
              setDigest(revision.digest);
              setPath(null);
            }}
          >
            <code>{short(revision.digest)}</code>
            {revision.digest === asset.pinned ? ' · 使用中' : revision.digest === asset.latest ? ' · 最新' : ''}
            <span className="block">{at(revision.createdAt)}</span>
          </button>
        ))}
      </div>
      {current ? (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Tabs
              value={view}
              onChange={setView}
              options={[
                ['files', '文件'],
                ['diff', previous ? `与上一版 ${short(previous.digest)} 的差异` : '差异']
              ]}
            />
          </div>
          <p className="mb-2 break-all text-meta text-tertiary">
            {current.commit ? `提交 ${current.commit.slice(0, 10)} · ` : ''}
            {current.files.length} 个文件
          </p>
          <div className="min-h-0 flex-1 overflow-auto">
            {view === 'diff' ? (
              previous ? (
                <DiffBody asset={asset} from={previous.digest} to={current.digest} />
              ) : (
                <p className="text-meta text-tertiary">这是第一个版本。</p>
              )
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row">
                <ul className="flex shrink-0 gap-1 overflow-x-auto sm:w-[200px] sm:flex-col sm:overflow-visible">
                  {current.files.map((file) => (
                    <li key={file.path}>
                      <button
                        className={`w-full truncate rounded-sm px-2 py-1 text-left font-mono text-meta ${
                          file.path === shown ? 'bg-card-raised text-primary' : 'text-tertiary hover:text-secondary'
                        }`}
                        onClick={() => setPath(file.path)}
                      >
                        {file.path}
                      </button>
                    </li>
                  ))}
                </ul>
                {shown ? <FileView asset={asset} digest={current.digest} path={shown} /> : null}
              </div>
            )}
          </div>
          {digest !== asset.pinned ? (
            <div className="mt-3 flex items-center justify-end gap-2">
              {pin.error ? <span className="text-meta text-rust">{errorText(pin.error)}</span> : null}
              <button
                className={PRIMARY_BUTTON}
                disabled={pin.isPending}
                onClick={() => {
                  if (window.confirm(`把「${asset.name}」切到 ${short(digest)}？已装的机器会同步到这个版本。`))
                    pin.mutate(digest, { onSuccess: onClose });
                }}
              >
                使用这个版本
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-meta text-tertiary">{revisions.isLoading ? '载入中…' : '没有版本'}</p>
      )}
    </DialogShell>
  );
}

function FileView({ asset, digest, path }: { asset: Asset; digest: string; path: string }) {
  const file = useQuery({
    queryKey: ['admin', 'assets', asset.id, 'file', digest, path],
    queryFn: () => assetsApi.file(asset.id, digest, path),
    staleTime: Infinity
  });
  const body: ReactNode = file.isLoading ? (
    <span className="text-tertiary">载入中…</span>
  ) : file.error ? (
    <span className="text-rust">{errorText(file.error)}</span>
  ) : (
    file.data?.text
  );
  return (
    <pre className="min-h-[160px] min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-hair bg-card p-2.5 font-mono text-[12px] leading-[1.5] text-secondary">
      {body}
    </pre>
  );
}

