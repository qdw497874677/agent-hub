import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DialogShell, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from './dialog-shell.tsx';
import { providersApi, type ProviderDto, type ProviderInputDto } from './api.ts';
import { useAccount } from './auth.tsx';
import { useWorkers } from './workers.tsx';

/**
 * 模型提供商（ADR 0013）：个人 / 团队 / 全站三种作用域。
 * 密钥只写不读；选了它的模型开会话时，hub 只把这一个提供商配给 agent（真密钥留在 worker 中继或 hub 里）。
 */
const SMALL = 'shrink-0 rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-accent hover:text-accent disabled:opacity-40';
const SCOPE_LABEL = { personal: '个人', team: '团队', hub: '全站' } as const;
const PROTOCOL_LABEL = { 'openai-chat': 'OpenAI Chat Completions', 'openai-responses': 'OpenAI Responses', anthropic: 'Anthropic Messages' } as const;

const blank: ProviderInputDto & { scope: 'personal' | 'team' | 'hub'; apiKey: string } = {
  slug: '',
  name: '',
  protocol: 'openai-chat',
  baseUrl: '',
  models: [],
  routing: 'direct',
  enabled: true,
  scope: 'personal',
  apiKey: ''
};

function errorText(error: unknown): string | null {
  return error ? (error instanceof Error ? error.message : String(error)) : null;
}

export function ProvidersDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const me = useAccount();
  const list = useQuery({ queryKey: ['providers'], queryFn: providersApi.list });
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['providers'] }), queryClient.invalidateQueries({ queryKey: ['hub-models'] })]);
  const [editing, setEditing] = useState<ProviderDto | 'new' | null>(null);
  const providers = list.data?.providers ?? [];
  return (
    <DialogShell title="模型提供商" onClose={onClose} wide>
      <p className="text-sub text-primary">模型提供商</p>
      <p className="mt-1 text-meta text-tertiary">
        接一个 OpenAI / Anthropic 兼容的端点，它的模型就会出现在开会话的模型列表里（显示为 hub-标识/模型）。密钥只写不读，不会进 agent 的配置文件。
      </p>
      {editing ? (
        <ProviderForm
          existing={editing === 'new' ? null : editing}
          canHub={me?.hubAdmin === true}
          canTeam={me?.role === 'owner' || me?.hubAdmin === true}
          onDone={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      ) : (
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {list.isPending ? <p className="text-meta text-tertiary">加载中…</p> : null}
          {list.error ? <p className="text-meta text-rust">{errorText(list.error)}</p> : null}
          {providers.length === 0 && !list.isPending ? <p className="text-meta text-tertiary">还没有模型提供商。</p> : null}
          <ul className="flex flex-col gap-2">
            {providers.map((provider) => (
              <ProviderRow key={provider.id} provider={provider} onEdit={() => setEditing(provider)} onChanged={refresh} />
            ))}
          </ul>
          <button className={`mt-3 ${PRIMARY_BUTTON}`} onClick={() => setEditing('new')}>
            添加模型提供商
          </button>
        </div>
      )}
    </DialogShell>
  );
}

function ProviderRow({ provider, onEdit, onChanged }: { provider: ProviderDto; onEdit: () => void; onChanged: () => Promise<unknown> }) {
  const workers = useWorkers();
  const online = workers.list.filter((worker) => worker.state === 'online');
  const [workerId, setWorkerId] = useState('');
  const target = workerId || online[0]?.workerId || '';
  const test = useMutation({ mutationFn: () => providersApi.test(provider.id, target), onSettled: onChanged });
  const remove = useMutation({ mutationFn: () => providersApi.remove(provider.id), onSuccess: onChanged });
  const check = test.data ?? provider.lastCheck;
  return (
    <li className="rounded-sm border border-hair p-3" data-testid={`provider-${provider.slug}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sub text-primary">{provider.name}</span>
        <span className="text-meta text-tertiary">hub-{provider.slug}</span>
        <span className="rounded-sm border border-hair px-1.5 text-meta text-secondary">{SCOPE_LABEL[provider.scope]}</span>
        <span className="text-meta text-tertiary">{PROTOCOL_LABEL[provider.protocol]}</span>
        <span className="text-meta text-tertiary">{provider.routing === 'hub' ? '经 hub 中转' : 'worker 直连'}</span>
        {!provider.enabled ? <span className="text-meta text-rust">已停用</span> : null}
        {!provider.hasKey ? <span className="text-meta text-rust">未配置密钥</span> : null}
      </div>
      <p className="mt-1 break-all text-meta text-tertiary">
        {provider.baseUrl} · {provider.models.map((model) => model.id).join('、')}
      </p>
      <p className="mt-1 text-meta text-tertiary">
        用量：{provider.usage.sessions} 个会话 · 经 hub {provider.usage.requests} 次请求（{provider.usage.errors} 次失败）
      </p>
      {check ? (
        <p className={`mt-1 text-meta ${check.ok ? 'text-secondary' : 'text-rust'}`} data-testid="provider-check">
          {check.ok ? '✓' : '✗'} {check.message}（{check.via === 'hub' ? 'worker→hub→提供商' : 'worker→提供商'}，{check.workerId}）
        </p>
      ) : null}
      {test.error ? <p className="mt-1 text-meta text-rust">{errorText(test.error)}</p> : null}
      {provider.canManage ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select className={`${INPUT} w-auto py-1 text-meta`} aria-label="从哪台机器测" value={target} onChange={(event) => setWorkerId(event.target.value)}>
            {online.length === 0 ? <option value="">没有在线机器</option> : null}
            {online.map((worker) => (
              <option key={worker.workerId} value={worker.workerId}>
                {worker.label}
              </option>
            ))}
          </select>
          <button className={SMALL} disabled={!target || test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? '测试中…' : '测试连接'}
          </button>
          <button className={SMALL} onClick={onEdit}>
            编辑
          </button>
          <button
            className={SMALL}
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(`删除模型提供商「${provider.name}」？用它的会话下次启动会失败。`)) remove.mutate();
            }}
          >
            删除
          </button>
        </div>
      ) : null}
    </li>
  );
}

function ProviderForm({ existing, canHub, canTeam, onDone }: { existing: ProviderDto | null; canHub: boolean; canTeam: boolean; onDone: () => Promise<unknown> | void }) {
  const [form, setForm] = useState(() =>
    existing
      ? { ...blank, ...existing, models: [...existing.models], apiKey: '' }
      : { ...blank }
  );
  const [modelsText, setModelsText] = useState(() => (existing ? existing.models.map((model) => model.id).join('\n') : ''));
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [key]: value }));
  const save = useMutation({
    mutationFn: async () => {
      const models = modelsText
        .split(/[\n,]/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((id) => existing?.models.find((model) => model.id === id) ?? { id });
      const input: ProviderInputDto = { slug: form.slug, name: form.name, protocol: form.protocol, baseUrl: form.baseUrl, models, routing: form.routing, enabled: form.enabled };
      if (existing) {
        await providersApi.update(existing.id, input);
        if (form.apiKey) await providersApi.setKey(existing.id, form.apiKey);
      } else {
        await providersApi.create({ ...input, scope: form.scope, ...(form.apiKey ? { apiKey: form.apiKey } : {}) });
      }
    },
    onSuccess: () => onDone()
  });
  const label = 'mb-1 mt-3 block text-meta text-secondary';
  return (
    <form
      className="mt-2 min-h-0 flex-1 overflow-y-auto"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="provider-name">名称</label>
          <input id="provider-name" className={INPUT} value={form.name} onChange={(event) => set('name', event.target.value)} placeholder="我的网关" />
        </div>
        <div>
          <label className={label} htmlFor="provider-slug">标识（进模型 id：hub-标识/模型）</label>
          <input id="provider-slug" className={INPUT} value={form.slug} disabled={existing !== null} onChange={(event) => set('slug', event.target.value)} placeholder="gw" />
        </div>
        <div>
          <label className={label} htmlFor="provider-scope">作用域</label>
          <select id="provider-scope" className={INPUT} value={form.scope} disabled={existing !== null} onChange={(event) => set('scope', event.target.value as typeof form.scope)}>
            <option value="personal">个人（只有我能用）</option>
            {canTeam ? <option value="team">团队（本团队项目可用）</option> : null}
            {canHub ? <option value="hub">全站（所有人可用）</option> : null}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="provider-protocol">协议</label>
          <select id="provider-protocol" className={INPUT} value={form.protocol} onChange={(event) => set('protocol', event.target.value as typeof form.protocol)}>
            {Object.entries(PROTOCOL_LABEL).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className={label} htmlFor="provider-base">Base URL</label>
      <input id="provider-base" className={INPUT} value={form.baseUrl} onChange={(event) => set('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" />
      <label className={label} htmlFor="provider-key">API Key{existing?.hasKey ? '（已配置；留空不改）' : ''}</label>
      <input id="provider-key" className={INPUT} type="password" autoComplete="off" value={form.apiKey} onChange={(event) => set('apiKey', event.target.value)} />
      <label className={label} htmlFor="provider-models">模型 id（一行一个）</label>
      <textarea id="provider-models" className={`${INPUT} h-24 font-mono`} value={modelsText} onChange={(event) => setModelsText(event.target.value)} />
      <label className={label} htmlFor="provider-routing">请求怎么走</label>
      <select id="provider-routing" className={INPUT} value={form.routing} onChange={(event) => set('routing', event.target.value as typeof form.routing)}>
        <option value="direct">worker 直连（默认：密钥下发到 worker 的本机中继）</option>
        <option value="hub">经 hub 中转（密钥不离开 hub；worker 要能连到 hub）</option>
      </select>
      <label className="mt-3 flex items-center gap-2 text-meta text-secondary">
        <input type="checkbox" checked={form.enabled} onChange={(event) => set('enabled', event.target.checked)} /> 启用
      </label>
      {save.error ? <p className="mt-2 text-meta text-rust">{errorText(save.error)}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={SECONDARY_BUTTON} onClick={() => void onDone()}>
          取消
        </button>
        <button type="submit" className={PRIMARY_BUTTON} disabled={save.isPending}>
          {save.isPending ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}
