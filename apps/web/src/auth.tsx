import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi, RequestFailed, UNAUTHORIZED_EVENT, type AccountDto, type AuthState } from './api.ts';

/**
 * 登录闸门：没登录只渲染登录/注册页；登录后把当前账号放进 context。
 * 旧链接里的 `?token=…` 自动换成一次 HUB_TOKEN 登录（30 天过渡期内）。
 */
const AccountContext = createContext<AccountDto | null>(null);
export const useAccount = (): AccountDto | null => useContext(AccountContext);

const STATE_KEY = ['auth'] as const;

function takeUrlToken(): string | null {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (!token) return null;
  url.searchParams.delete('token');
  window.history.replaceState(null, '', url.toString());
  localStorage.removeItem('agent-hub:token'); // 老版本存过，清掉
  return token;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const urlToken = useRef<string | null>(typeof window === 'undefined' ? null : takeUrlToken());
  const [exchanging, setExchanging] = useState(urlToken.current !== null);
  const state = useQuery({ queryKey: STATE_KEY, queryFn: authApi.state, enabled: !exchanging, staleTime: Infinity });

  useEffect(() => {
    const token = urlToken.current;
    if (token === null) return;
    urlToken.current = null;
    void authApi.tokenLogin(token).catch(() => undefined).finally(() => setExchanging(false));
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      queryClient.setQueryData<AuthState | undefined>(STATE_KEY, (old) => (old ? { ...old, user: null } : old));
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [queryClient]);

  if (exchanging || state.isPending) return <Splash text="正在确认身份…" />;
  if (state.isError) return <Splash text="连不上服务端，稍后刷新重试" />;
  if (!state.data.user) return <LoginPage state={state.data} />;
  return <AccountContext.Provider value={state.data.user}>{children}</AccountContext.Provider>;
}

function Splash({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center text-meta text-tertiary">{text}</div>;
}

const INPUT =
  'w-full rounded-sm border border-hair bg-card px-3 py-2.5 text-body text-primary outline-none placeholder:text-tertiary focus:border-accent';
const PRIMARY = 'w-full rounded-sm bg-accent px-3 py-2.5 text-sub text-canvas hover:brightness-110 disabled:opacity-40';

type Mode = 'login' | 'register' | 'token';

function LoginPage({ state }: { state: AuthState }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [token, setToken] = useState('');

  const submit = useMutation({
    mutationFn: () =>
      mode === 'login'
        ? authApi.login(email, password)
        : mode === 'register'
          ? authApi.register(email, password, displayName.trim() || undefined)
          : authApi.tokenLogin(token),
    onSuccess: async () => {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
      await queryClient.invalidateQueries({ queryKey: STATE_KEY });
    }
  });
  const error = submit.error instanceof RequestFailed ? submit.error.detail.message : submit.error ? '网络出错了，再试一次' : null;
  const ready = mode === 'token' ? token !== '' : email.trim() !== '' && password !== '';

  const tabs: { id: Mode; label: string }[] = [
    { id: 'login', label: '登录' },
    ...(state.registration ? [{ id: 'register' as const, label: '注册' }] : []),
    ...(state.tokenLogin ? [{ id: 'token' as const, label: 'HUB_TOKEN' }] : [])
  ];

  return (
    <main className="flex min-h-full items-start justify-center overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(12vh,env(safe-area-inset-top))]">
      <div className="w-full max-w-[380px]">
        <p className="text-head text-primary">agent-hub</p>
        <p className="mb-6 mt-1 text-meta text-tertiary">自带机器与 agent 的工作台</p>

        <div role="tablist" className="mb-5 flex gap-1 border-b border-hair">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={mode === tab.id}
              className={`-mb-px border-b-2 px-3 py-2 text-sub ${
                mode === tab.id ? 'border-accent text-primary' : 'border-transparent text-tertiary hover:text-secondary'
              }`}
              onClick={() => {
                setMode(tab.id);
                submit.reset();
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !submit.isPending) submit.mutate();
          }}
        >
          {mode === 'token' ? (
            <>
              <label className="text-meta text-secondary" htmlFor="auth-token">部署时设置的 HUB_TOKEN（30 天过渡期内可用）</label>
              <input id="auth-token" type="password" autoComplete="off" className={INPUT} value={token} onChange={(e) => setToken(e.target.value)} />
            </>
          ) : (
            <>
              <label className="text-meta text-secondary" htmlFor="auth-email">邮箱</label>
              <input
                id="auth-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                className={INPUT}
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {mode === 'register' && (
                <>
                  <label className="text-meta text-secondary" htmlFor="auth-name">名字（可留空）</label>
                  <input id="auth-name" autoComplete="nickname" className={INPUT} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                </>
              )}
              <label className="text-meta text-secondary" htmlFor="auth-password">密码{mode === 'register' ? '（至少 10 位）' : ''}</label>
              <input
                id="auth-password"
                type="password"
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                className={INPUT}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </>
          )}
          {error && (
            <p role="alert" className="text-meta text-rust">
              {error}
            </p>
          )}
          <button type="submit" className={`mt-2 ${PRIMARY}`} disabled={!ready || submit.isPending}>
            {submit.isPending ? '请稍候…' : mode === 'register' ? '注册并进入' : '登录'}
          </button>
        </form>
      </div>
    </main>
  );
}

/** 头部的账号按钮：显示首字，点开看邮箱、退出登录。 */
export function AccountMenu() {
  const account = useAccount();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const leave = useMutation({
    mutationFn: authApi.logout,
    onSettled: () => {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
      queryClient.setQueryData<AuthState | undefined>(STATE_KEY, (old) => (old ? { ...old, user: null } : old));
    }
  });
  if (!account) return null;
  return (
    <div className="relative">
      <button
        aria-label="账号"
        aria-expanded={open}
        className="flex h-7 w-7 items-center justify-center rounded-full border border-hair text-meta text-secondary hover:border-accent hover:text-accent"
        onClick={() => setOpen((value) => !value)}
      >
        {account.displayName.slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-40 w-56 rounded-md border border-strong bg-panel p-3 text-meta">
          <p className="truncate text-primary">{account.displayName}</p>
          <p className="truncate text-tertiary">{account.email}</p>
          <p className="mt-1 text-tertiary">{account.role === 'owner' ? '主人' : '成员'}</p>
          {account.role === 'owner' ? (
            <a
              href="#/admin/overview"
              className="mt-3 block w-full rounded-sm border border-hair px-2 py-1.5 text-center text-secondary hover:border-accent hover:text-accent"
              onClick={() => setOpen(false)}
            >
              运营后台
            </a>
          ) : null}
          <button
            className="mt-3 w-full rounded-sm border border-hair px-2 py-1.5 text-secondary hover:border-rust hover:text-rust"
            onClick={() => leave.mutate()}
            disabled={leave.isPending}
          >
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}
