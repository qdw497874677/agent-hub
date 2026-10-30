import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ProvidersDialog } from './providers-dialog.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi, teamApi, RequestFailed, UNAUTHORIZED_EVENT, type AccountDto, type AuthState, type LoginDeviceDto } from './api.ts';
import { DialogShell } from './dialog-shell.tsx';
import { AuditView } from './admin/audit.tsx';

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

/** 邮件里的链接是 `#/verify?token=…` / `#/reset?token=…`：令牌只在 hash 里，不进服务端日志和 Referer。 */
type MailLink = { kind: 'verify' | 'reset' | 'invite'; token: string };
function takeMailLink(): MailLink | null {
  const match = /^#\/(verify|reset|invite)\?(.*)$/.exec(window.location.hash);
  if (!match) return null;
  const token = new URLSearchParams(match[2]).get('token');
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/`);
  return token ? { kind: match[1] as MailLink['kind'], token } : null;
}

const message = (error: unknown): string | null =>
  error instanceof RequestFailed ? error.detail.message : error ? '网络出错了，再试一次' : null;

export function AuthGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const urlToken = useRef<string | null>(typeof window === 'undefined' ? null : takeUrlToken());
  const [exchanging, setExchanging] = useState(urlToken.current !== null);
  const [mailLink, setMailLink] = useState<MailLink | null>(() => (typeof window === 'undefined' ? null : takeMailLink()));
  const state = useQuery({ queryKey: STATE_KEY, queryFn: authApi.state, enabled: !exchanging, staleTime: Infinity });

  useEffect(() => {
    const token = urlToken.current;
    if (token === null) return;
    urlToken.current = null;
    void authApi.tokenLogin(token).catch(() => undefined).finally(() => setExchanging(false));
  }, []);

  useEffect(() => {
    // 已经开着 hub 的标签页里再点信里的链接：只变 hash，不会重新加载
    const onHash = () => {
      const link = takeMailLink();
      if (link) setMailLink(link);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      queryClient.setQueryData<AuthState | undefined>(STATE_KEY, (old) => (old ? { ...old, user: null } : old));
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [queryClient]);

  if (mailLink?.kind === 'reset') return <ResetPasswordPage token={mailLink.token} onDone={() => setMailLink(null)} />;
  if (mailLink?.kind === 'invite') return <AcceptInvitePage token={mailLink.token} onDone={() => setMailLink(null)} />;
  if (mailLink?.kind === 'verify') return <VerifyLinkPage token={mailLink.token} onDone={() => setMailLink(null)} />;
  if (exchanging || state.isPending) return <Splash text="正在确认身份…" />;
  if (state.isError) return <Splash text="连不上服务端，稍后刷新重试" />;
  if (!state.data.user) return <LoginPage state={state.data} />;
  if (!state.data.user.emailVerified) return <VerifyEmailPage user={state.data.user} mailDelivery={state.data.mailDelivery} />;
  return <AccountContext.Provider value={state.data.user}>{children}</AccountContext.Provider>;
}

function Splash({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center text-meta text-tertiary">{text}</div>;
}

const INPUT =
  'w-full rounded-sm border border-hair bg-card px-3 py-2.5 text-body text-primary outline-none placeholder:text-tertiary focus:border-accent';
const PRIMARY = 'w-full rounded-sm bg-accent px-3 py-2.5 text-sub text-canvas hover:brightness-110 disabled:opacity-40';

type Mode = 'login' | 'register' | 'token' | 'forgot';

function LoginPage({ state }: { state: AuthState }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [token, setToken] = useState('');

  const [forgotSent, setForgotSent] = useState(false);
  const [registerSent, setRegisterSent] = useState(false);
  const submit = useMutation({
    mutationFn: async () => {
      if (mode === 'forgot') {
        await authApi.forgotPassword(email.trim());
        setForgotSent(true);
        return;
      }
      if (mode === 'register') {
        const result = await authApi.register(email, password, displayName.trim() || undefined);
        // 自助注册：不管邮箱是否已存在都是同一个回应，要去邮箱点链接后再登录
        if ('checkEmail' in result) setRegisterSent(true);
        return result;
      }
      return mode === 'login' ? authApi.login(email, password) : authApi.tokenLogin(token);
    },
    onSuccess: async (result) => {
      if (mode === 'forgot') return;
      if (result && 'checkEmail' in result) return;
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
      await queryClient.invalidateQueries({ queryKey: STATE_KEY });
    }
  });
  const error = message(submit.error);
  const ready = mode === 'token' ? token !== '' : mode === 'forgot' ? email.trim() !== '' : email.trim() !== '' && password !== '';
  const switchTo = (next: Mode) => {
    setMode(next);
    setForgotSent(false);
    setRegisterSent(false);
    submit.reset();
  };

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
              aria-selected={mode === tab.id || (mode === 'forgot' && tab.id === 'login')}
              className={`-mb-px border-b-2 px-3 py-2 text-sub ${
                mode === tab.id || (mode === 'forgot' && tab.id === 'login') ? 'border-accent text-primary' : 'border-transparent text-tertiary hover:text-secondary'
              }`}
              onClick={() => switchTo(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {!state.registration && mode === 'login' && (
          <p className="mb-4 rounded-sm border border-hair bg-card px-3 py-2 text-meta text-tertiary">
            这个 hub 暂不开放注册。想加入请联系管理员。
          </p>
        )}
        {mode === 'register' && registerSent ? (
          <div className="flex flex-col gap-3" role="status">
            <p className="text-body text-primary">去邮箱看看</p>
            <p className="text-meta text-secondary">
              我们给 <span className="text-primary">{email.trim()}</span> 发了一封信，点里面的链接验证邮箱后就能登录。没收到的话看看垃圾箱。
            </p>
            <button type="button" className={`mt-2 ${PRIMARY}`} onClick={() => switchTo('login')}>
              回到登录
            </button>
          </div>
        ) : mode === 'forgot' && forgotSent ? (
          <div className="flex flex-col gap-3" role="status">
            <p className="text-body text-primary">去邮箱看看</p>
            <p className="text-meta text-secondary">
              如果 <span className="text-primary">{email.trim()}</span> 注册过，我们已经发了一封重置密码的信，链接 30 分钟内有效。没收到的话看看垃圾箱。
            </p>
            <button type="button" className={`mt-2 ${PRIMARY}`} onClick={() => switchTo('login')}>
              回到登录
            </button>
          </div>
        ) : (
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
              {mode !== 'forgot' && mode === 'register' && (
                <>
                  <label className="text-meta text-secondary" htmlFor="auth-name">名字（可留空）</label>
                  <input id="auth-name" autoComplete="nickname" className={INPUT} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                </>
              )}
              {mode !== 'forgot' && (
                <>
                  <div className="flex items-baseline justify-between">
                    <label className="text-meta text-secondary" htmlFor="auth-password">密码{mode === 'register' ? '（至少 10 位）' : ''}</label>
                    {mode === 'login' && (
                      <button type="button" className="text-meta text-tertiary hover:text-accent" onClick={() => switchTo('forgot')}>
                        忘记密码？
                      </button>
                    )}
                  </div>
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
              {mode === 'forgot' && <p className="text-meta text-tertiary">输入注册时用的邮箱，我们会发一封重置密码的信。</p>}
            </>
          )}
          {error && (
            <p role="alert" className="text-meta text-rust">
              {error}
            </p>
          )}
          <button type="submit" className={`mt-2 ${PRIMARY}`} disabled={!ready || submit.isPending}>
            {submit.isPending ? '请稍候…' : mode === 'register' ? '注册' : mode === 'forgot' ? '发送重置邮件' : '登录'}
          </button>
          {mode === 'forgot' && (
            <button type="button" className="text-meta text-tertiary hover:text-accent" onClick={() => switchTo('login')}>
              想起来了，回到登录
            </button>
          )}
        </form>
        )}
      </div>
    </main>
  );
}

/** 窄屏优先的居中卡片：图标 + 标题 + 正文 + 操作。 */
function Card({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-full items-start justify-center overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(12vh,env(safe-area-inset-top))]">
      <div className="w-full max-w-[380px]">
        <div aria-hidden className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-hair bg-card text-[22px]">
          {icon}
        </div>
        <p className="text-head text-primary">{title}</p>
        <div className="mt-3 flex flex-col gap-3">{children}</div>
      </div>
    </main>
  );
}

const SECONDARY = 'w-full rounded-sm border border-hair px-3 py-2.5 text-sub text-secondary hover:border-accent hover:text-accent disabled:opacity-40';

function mailboxHint(email: string): string {
  const domain = email.split('@')[1] ?? '';
  return domain ? `去 ${domain} 邮箱查收` : '去邮箱查收';
}

/** 登录了但邮箱没验证：只给这一页。 */
function VerifyEmailPage({ user, mailDelivery }: { user: AccountDto; mailDelivery: boolean }) {
  const queryClient = useQueryClient();
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  const resend = useMutation({
    mutationFn: authApi.resendVerification,
    onSuccess: async (result) => {
      setCooldown(60);
      if (result.alreadyVerified) await queryClient.invalidateQueries({ queryKey: STATE_KEY });
    }
  });
  const refresh = useMutation({ mutationFn: () => queryClient.invalidateQueries({ queryKey: STATE_KEY }) });
  const leave = useMutation({
    mutationFn: authApi.logout,
    onSettled: () => queryClient.setQueryData<AuthState | undefined>(STATE_KEY, (old) => (old ? { ...old, user: null } : old))
  });
  return (
    <Card icon="✉️" title="去验证邮箱">
      <p className="text-meta text-secondary">
        我们给 <span className="text-primary">{user.email}</span> 发了一封确认信，点里面的链接就能开始用。链接 30 分钟内有效。
      </p>
      <p className="text-meta text-tertiary">{mailboxHint(user.email)}，没看到的话翻翻垃圾箱。</p>
      {!mailDelivery && (
        <p className="rounded-sm border border-hair bg-card px-3 py-2 text-meta text-tertiary">
          这个 hub 还没配置发信服务，信不会真的寄出。请联系管理员在后台把你标记为已验证。
        </p>
      )}
      {resend.isSuccess && cooldown > 0 && <p role="status" className="text-meta text-secondary">已重新发送。</p>}
      {resend.error && <p role="alert" className="text-meta text-rust">{message(resend.error)}</p>}
      <button className={PRIMARY} onClick={() => refresh.mutate()} disabled={refresh.isPending}>
        我已经点过链接了
      </button>
      <button className={SECONDARY} onClick={() => resend.mutate()} disabled={resend.isPending || cooldown > 0}>
        {cooldown > 0 ? `重新发送（${cooldown} 秒）` : resend.isPending ? '发送中…' : '重新发送验证邮件'}
      </button>
      <button className="text-meta text-tertiary hover:text-rust" onClick={() => leave.mutate()}>
        换个账号登录
      </button>
    </Card>
  );
}

/** 打开邮件里的验证链接。 */
function VerifyLinkPage({ token, onDone }: { token: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const verify = useMutation({
    mutationFn: () => authApi.verifyEmail(token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STATE_KEY })
  });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    verify.mutate();
  }, [verify]);
  if (verify.isError)
    return (
      <Card icon="⚠️" title="链接用不了">
        <p className="text-meta text-secondary">{message(verify.error)}</p>
        <button className={PRIMARY} onClick={onDone}>
          回到 agent-hub
        </button>
      </Card>
    );
  if (verify.isSuccess)
    return (
      <Card icon="✅" title="邮箱已验证">
        <p className="text-meta text-secondary">{verify.data.user.email} 已确认，可以开始用了。</p>
        <button className={PRIMARY} onClick={onDone}>
          进入 agent-hub
        </button>
      </Card>
    );
  return <Splash text="正在验证邮箱…" />;
}

/** 打开邮件里的重置密码链接：设新密码，成功后直接登录。 */
function ResetPasswordPage({ token, onDone }: { token: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const reset = useMutation({
    mutationFn: () => authApi.resetPassword(token, password),
    onSuccess: async () => {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
      await queryClient.invalidateQueries({ queryKey: STATE_KEY });
    }
  });
  const mismatch = again !== '' && again !== password;
  if (reset.isSuccess)
    return (
      <Card icon="🔑" title="密码已更新">
        <p className="text-meta text-secondary">其他设备上的登录都已退出，这台已经帮你登录好了。</p>
        <button className={PRIMARY} onClick={onDone}>
          进入 agent-hub
        </button>
      </Card>
    );
  return (
    <Card icon="🔑" title="设置新密码">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (password && !mismatch && !reset.isPending) reset.mutate();
        }}
      >
        <label className="text-meta text-secondary" htmlFor="reset-password">新密码（至少 10 位）</label>
        <input id="reset-password" type="password" autoComplete="new-password" className={INPUT} value={password} onChange={(e) => setPassword(e.target.value)} />
        <label className="text-meta text-secondary" htmlFor="reset-again">再输一遍</label>
        <input id="reset-again" type="password" autoComplete="new-password" className={INPUT} value={again} onChange={(e) => setAgain(e.target.value)} />
        {mismatch && <p className="text-meta text-rust">两次输入不一样</p>}
        {reset.error && <p role="alert" className="text-meta text-rust">{message(reset.error)}</p>}
        <button type="submit" className={`mt-2 ${PRIMARY}`} disabled={!password || again !== password || reset.isPending}>
          {reset.isPending ? '请稍候…' : '保存并登录'}
        </button>
        <button type="button" className="text-meta text-tertiary hover:text-accent" onClick={onDone}>
          取消
        </button>
      </form>
    </Card>
  );
}

function describeDevice(ua: string | null): string {
  if (!ua) return '未知设备';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : null;
  return [browser, os].filter(Boolean).join(' · ') || ua.slice(0, 40);
}

const when = (ms: number) => new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 我的登录设备：逐台登出，或一键登出其他所有设备。 */
function DevicesDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['auth', 'logins'], queryFn: authApi.logins });
  const afterRevoke = async (result?: { current?: boolean }) => {
    if (result?.current) {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
      queryClient.setQueryData<AuthState | undefined>(STATE_KEY, (old) => (old ? { ...old, user: null } : old));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ['auth', 'logins'] });
  };
  const revoke = useMutation({ mutationFn: authApi.revokeLogin, onSuccess: afterRevoke });
  const others = useMutation({ mutationFn: authApi.revokeOtherLogins, onSuccess: () => afterRevoke() });
  const devices: LoginDeviceDto[] = list.data ?? [];
  return (
    <DialogShell title="登录设备" onClose={onClose}>
      <p className="text-sub text-primary">登录设备</p>
      <p className="mt-1 text-meta text-tertiary">看到不认识的设备就登出它，然后改个密码。</p>
      {list.isPending ? (
        <p className="mt-4 text-meta text-tertiary">加载中…</p>
      ) : (
        <ul className="mt-3 flex max-h-[50dvh] flex-col gap-2 overflow-y-auto">
          {devices.map((device) => (
            <li key={device.id} className="flex items-center gap-3 rounded-sm border border-hair bg-card px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-meta text-primary">
                  {describeDevice(device.userAgent)}
                  {device.current && <span className="ml-2 rounded-sm bg-accent/15 px-1.5 py-0.5 text-[11px] text-accent">这台</span>}
                </p>
                <p className="truncate text-[11px] text-tertiary">
                  {device.ip ?? '未知 IP'} · 最近 {when(device.lastSeenAt)} · {device.method === 'password' ? '密码登录' : 'HUB_TOKEN'}
                </p>
              </div>
              <button
                className="shrink-0 rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-rust hover:text-rust disabled:opacity-40"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(device.id)}
              >
                登出
              </button>
            </li>
          ))}
        </ul>
      )}
      {(revoke.error || others.error) && <p role="alert" className="mt-2 text-meta text-rust">{message(revoke.error ?? others.error)}</p>}
      <button
        className="mt-4 w-full rounded-sm border border-hair px-3 py-2.5 text-sub text-secondary hover:border-rust hover:text-rust disabled:opacity-40"
        disabled={others.isPending || devices.length <= 1}
        onClick={() => others.mutate()}
      >
        {others.isSuccess && devices.length <= 1 ? '其他设备都已登出' : '登出其他所有设备'}
      </button>
    </DialogShell>
  );
}

/** 头部的账号按钮：显示首字，点开看邮箱、退出登录。 */
export function AccountMenu() {
  const account = useAccount();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState(false);
  const [team, setTeam] = useState(false);
  const [settings, setSettings] = useState(false);
  const [providers, setProviders] = useState(false);
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
          <p className="mt-1 text-tertiary">{account.hubAdmin ? 'hub 管理员' : account.role === 'owner' ? '主人' : '成员'}</p>
          {account.hubAdmin ? (
            <a
              href="#/admin/overview"
              className="mt-3 block w-full rounded-sm border border-hair px-2 py-1.5 text-center text-secondary hover:border-accent hover:text-accent"
              onClick={() => setOpen(false)}
            >
              运营后台
            </a>
          ) : null}
          <button
            className="mt-3 w-full rounded-sm border border-hair px-2 py-1.5 text-secondary hover:border-accent hover:text-accent"
            onClick={() => {
              setOpen(false);
              setDevices(true);
            }}
          >
            登录设备
          </button>
          <button
            className="mt-2 w-full rounded-sm border border-hair px-2 py-1.5 text-secondary hover:border-accent hover:text-accent"
            onClick={() => {
              setOpen(false);
              setTeam(true);
            }}
          >
            我的团队
          </button>
          <button
            className="mt-2 w-full rounded-sm border border-hair px-2 py-1.5 text-secondary hover:border-accent hover:text-accent"
            onClick={() => {
              setOpen(false);
              setSettings(true);
            }}
          >
            个人设置
          </button>
          <button
            className="mt-2 w-full rounded-sm border border-hair px-2 py-1.5 text-secondary hover:border-accent hover:text-accent"
            onClick={() => {
              setOpen(false);
              setProviders(true);
            }}
          >
            模型提供商
          </button>
          <button
            className="mt-2 w-full rounded-sm border border-hair px-2 py-1.5 text-secondary hover:border-rust hover:text-rust"
            onClick={() => leave.mutate()}
            disabled={leave.isPending}
          >
            退出登录
          </button>
        </div>
      )}
      {devices && <DevicesDialog onClose={() => setDevices(false)} />}
      {team && <TeamDialog onClose={() => setTeam(false)} />}
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
      {providers && <ProvidersDialog onClose={() => setProviders(false)} />}
    </div>
  );
}

const roleLabel = (role: 'owner' | 'member') => (role === 'owner' ? '主人' : '成员');
const SMALL_BTN = 'shrink-0 rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-accent hover:text-accent disabled:opacity-40';
const SMALL_DANGER = 'shrink-0 rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-rust hover:text-rust disabled:opacity-40';

/** 我的团队：人人能看成员；团队 owner（和 hub 管理员）能邀请、撤销邀请、改角色、删人。 */
function TeamDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const me = useAccount();
  const team = useQuery({ queryKey: ['team'], queryFn: teamApi.team });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['team'] });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'owner' | 'member'>('member');
  const [overLimit, setOverLimit] = useState(false);
  const invite = useMutation({
    mutationFn: () => teamApi.invite(email.trim(), role, overLimit),
    onSuccess: async () => {
      setEmail('');
      setOverLimit(false);
      await refresh();
    }
  });
  const act = useMutation({
    mutationFn: async (input: { kind: 'revoke' | 'role' | 'remove'; id: string; role?: 'owner' | 'member' }) => {
      if (input.kind === 'revoke') return teamApi.revokeInvite(input.id);
      if (input.kind === 'role') return teamApi.setRole(input.id, input.role!);
      return teamApi.remove(input.id);
    },
    onSuccess: refresh
  });
  const data = team.data;
  const full = data?.seatsLeft !== null && data?.seatsLeft !== undefined && data.seatsLeft <= 0;
  return (
    <DialogShell title="我的团队" onClose={onClose}>
      <p className="text-sub text-primary">{data?.name ?? '我的团队'}</p>
      <p className="mt-1 text-meta text-tertiary">
        成员能看到自己的项目和别人分享给他的；团队主人能看到团队里所有的项目。
        {data?.seatsLeft !== null && data?.seatsLeft !== undefined ? ` 剩余名额 ${Math.max(0, data.seatsLeft)}。` : ''}
      </p>
      {team.isPending ? (
        <p className="mt-4 text-meta text-tertiary">加载中…</p>
      ) : team.isError ? (
        <p role="alert" className="mt-4 text-meta text-rust">{message(team.error)}</p>
      ) : (
        <>
          <ul className="mt-3 flex max-h-[40dvh] flex-col gap-2 overflow-y-auto">
            {data!.members.map((member) => (
              <li key={member.id} data-testid="team-member" className="flex items-center gap-2 rounded-sm border border-hair bg-card px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-meta text-primary">
                    {member.displayName}
                    {member.id === me?.id && <span className="ml-2 text-[11px] text-tertiary">你</span>}
                  </p>
                  <p className="truncate text-[11px] text-tertiary">
                    {member.email} · {member.teamOwner ? '团队主人' : roleLabel(member.role)}
                    {member.disabled ? ' · 已停用' : ''}
                  </p>
                </div>
                {data!.canManage && !member.teamOwner && member.id !== me?.id && (
                  <>
                    <button
                      className={SMALL_BTN}
                      disabled={act.isPending}
                      onClick={() => act.mutate({ kind: 'role', id: member.id, role: member.role === 'owner' ? 'member' : 'owner' })}
                    >
                      {member.role === 'owner' ? '降为成员' : '设为主人'}
                    </button>
                    <button
                      className={SMALL_DANGER}
                      disabled={act.isPending}
                      onClick={() => {
                        if (window.confirm(`删除 ${member.email}？账号会被匿名化、立刻掉线，TA 的项目转给团队主人。不能撤销。`))
                          act.mutate({ kind: 'remove', id: member.id });
                      }}
                    >
                      删除
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {data!.canManage && (
            <>
              {data!.invites.length > 0 && (
                <>
                  <p className="mt-4 text-meta text-secondary">待接受的邀请</p>
                  <ul className="mt-2 flex flex-col gap-2">
                    {data!.invites.map((pending) => (
                      <li key={pending.id} data-testid="team-invite" className="flex items-center gap-2 rounded-sm border border-dashed border-hair px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-meta text-primary">{pending.email}</p>
                          <p className="truncate text-[11px] text-tertiary">
                            {roleLabel(pending.role)} · {when(pending.expiresAt)} 前有效{pending.allowOverLimit ? ' · 超出名额' : ''}
                          </p>
                        </div>
                        <button className={SMALL_DANGER} disabled={act.isPending} onClick={() => act.mutate({ kind: 'revoke', id: pending.id })}>
                          撤销
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <form
                className="mt-4 flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (email.trim() && !invite.isPending) invite.mutate();
                }}
              >
                <label className="text-meta text-secondary" htmlFor="invite-email">邀请新成员（对方会收到一封邀请信，7 天内有效）</label>
                <div className="flex gap-2">
                  <input
                    id="invite-email"
                    type="email"
                    autoCapitalize="none"
                    className={INPUT}
                    placeholder="name@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <select aria-label="角色" className="rounded-sm border border-hair bg-card px-2 text-meta text-primary" value={role} onChange={(e) => setRole(e.target.value as 'owner' | 'member')}>
                    <option value="member">成员</option>
                    <option value="owner">主人</option>
                  </select>
                </div>
                {full && data!.isTeamOwner && (
                  <label className="flex items-center gap-2 text-meta text-secondary">
                    <input type="checkbox" checked={overLimit} onChange={(e) => setOverLimit(e.target.checked)} />
                    名额已满，仍然邀请（超出 HUB_MAX_USERS）
                  </label>
                )}
                {invite.isSuccess && <p role="status" className="text-meta text-secondary">邀请已发出。</p>}
                {invite.error && <p role="alert" className="text-meta text-rust">{message(invite.error)}</p>}
                <button type="submit" className={PRIMARY} disabled={!email.trim() || invite.isPending}>
                  {invite.isPending ? '发送中…' : '发送邀请'}
                </button>
              </form>
            </>
          )}
          {act.error && <p role="alert" className="mt-2 text-meta text-rust">{message(act.error)}</p>}
          {data!.canManage && !me?.hubAdmin && (
            <details className="mt-4">
              <summary className="cursor-pointer text-meta text-secondary">团队安全审计</summary>
              <div className="mt-2 max-h-[40dvh] overflow-y-auto">
                <AuditView source="team" />
              </div>
            </details>
          )}
        </>
      )}
    </DialogShell>
  );
}

/** 个人设置：改显示名；改密码要原密码，改完其他设备都会退出。 */
function SettingsDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const me = useAccount();
  const [name, setName] = useState(me?.displayName ?? '');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [again, setAgain] = useState('');
  const profile = useMutation({
    mutationFn: () => authApi.updateProfile(name.trim()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STATE_KEY })
  });
  const password = useMutation({
    mutationFn: () => authApi.changePassword(oldPassword, newPassword),
    onSuccess: async () => {
      setOldPassword('');
      setNewPassword('');
      setAgain('');
      await queryClient.invalidateQueries({ queryKey: ['auth', 'logins'] });
    }
  });
  const mismatch = again !== '' && again !== newPassword;
  return (
    <DialogShell title="个人设置" onClose={onClose}>
      <p className="text-sub text-primary">个人设置</p>
      <form
        className="mt-3 flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && !profile.isPending) profile.mutate();
        }}
      >
        <label className="text-meta text-secondary" htmlFor="settings-name">显示名</label>
        <input id="settings-name" className={INPUT} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        {profile.isSuccess && <p role="status" className="text-meta text-secondary">已保存。</p>}
        {profile.error && <p role="alert" className="text-meta text-rust">{message(profile.error)}</p>}
        <button type="submit" className={SECONDARY} disabled={!name.trim() || name.trim() === me?.displayName || profile.isPending}>
          保存显示名
        </button>
      </form>
      <form
        className="mt-5 flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (oldPassword && newPassword && !mismatch && !password.isPending) password.mutate();
        }}
      >
        <p className="text-meta text-secondary">修改密码（改完后其他设备都会退出，这台保持登录，并给你发一封通知信）</p>
        <label className="text-meta text-secondary" htmlFor="settings-old">原密码</label>
        <input id="settings-old" type="password" autoComplete="current-password" className={INPUT} value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
        <label className="text-meta text-secondary" htmlFor="settings-new">新密码（至少 10 位）</label>
        <input id="settings-new" type="password" autoComplete="new-password" className={INPUT} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        <label className="text-meta text-secondary" htmlFor="settings-again">再输一遍</label>
        <input id="settings-again" type="password" autoComplete="new-password" className={INPUT} value={again} onChange={(e) => setAgain(e.target.value)} />
        {mismatch && <p className="text-meta text-rust">两次输入不一样</p>}
        {password.isSuccess && <p role="status" className="text-meta text-secondary">密码已修改，其他设备已退出。</p>}
        {password.error && <p role="alert" className="text-meta text-rust">{message(password.error)}</p>}
        <button type="submit" className={PRIMARY} disabled={!oldPassword || !newPassword || again !== newPassword || password.isPending}>
          {password.isPending ? '请稍候…' : '修改密码'}
        </button>
      </form>
    </DialogShell>
  );
}

/** 打开邀请信里的链接：看是谁邀请、进哪个团队，设密码就加入（邮箱算已验证）。 */
function AcceptInvitePage({ token, onDone }: { token: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const preview = useQuery({ queryKey: ['auth', 'invite', token], queryFn: () => authApi.previewInvite(token), retry: false });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const accept = useMutation({
    mutationFn: () => authApi.acceptInvite(token, password, name.trim() || undefined),
    onSuccess: async () => {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
      await queryClient.invalidateQueries({ queryKey: STATE_KEY });
      onDone();
    }
  });
  const mismatch = again !== '' && again !== password;
  if (preview.isPending) return <Splash text="正在打开邀请…" />;
  if (preview.isError)
    return (
      <Card icon="⚠️" title="邀请用不了">
        <p className="text-meta text-secondary">{message(preview.error)}</p>
        <button className={PRIMARY} onClick={onDone}>回到 agent-hub</button>
      </Card>
    );
  return (
    <Card icon="👋" title={`加入「${preview.data.teamName}」`}>
      <p className="text-meta text-secondary">
        {preview.data.inviterName} 邀请 <span className="text-primary">{preview.data.email}</span> 以{roleLabel(preview.data.role)}身份加入。设个密码就能开始用。
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (password && !mismatch && !accept.isPending) accept.mutate();
        }}
      >
        <label className="text-meta text-secondary" htmlFor="invite-name">名字（可留空）</label>
        <input id="invite-name" autoComplete="nickname" className={INPUT} value={name} onChange={(e) => setName(e.target.value)} />
        <label className="text-meta text-secondary" htmlFor="invite-password">密码（至少 10 位）</label>
        <input id="invite-password" type="password" autoComplete="new-password" className={INPUT} value={password} onChange={(e) => setPassword(e.target.value)} />
        <label className="text-meta text-secondary" htmlFor="invite-again">再输一遍</label>
        <input id="invite-again" type="password" autoComplete="new-password" className={INPUT} value={again} onChange={(e) => setAgain(e.target.value)} />
        {mismatch && <p className="text-meta text-rust">两次输入不一样</p>}
        {accept.error && <p role="alert" className="text-meta text-rust">{message(accept.error)}</p>}
        <button type="submit" className={`mt-2 ${PRIMARY}`} disabled={!password || again !== password || accept.isPending}>
          {accept.isPending ? '请稍候…' : '加入并登录'}
        </button>
      </form>
    </Card>
  );
}
