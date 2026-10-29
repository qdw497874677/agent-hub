import { appendFileSync } from 'node:fs';
import { createTransport } from 'nodemailer';
import type { EmailSender } from '@agent-hub/domain';
import { renderAccountMail } from './mail-templates.ts';
import type { RenderedMail } from './mail-templates.ts';

/** 真正把信送出去的那一层。模板渲染在它上面（createAccountMailer），换服务商不碰措辞。 */
export interface MailTransport {
  /** 'smtp' | 'resend' | 'log'：日志里说清楚信走的哪条路。 */
  readonly name: string;
  deliver(mail: RenderedMail): Promise<void>;
}

/**
 * Resend（https://resend.com/docs/api-reference/emails/send-email）。
 * 整个 API 就一个 POST，直接用 fetch，不为它多装一个 SDK。
 */
export function createResendTransport(options: { apiKey: string; from: string; fetch?: typeof fetch }): MailTransport {
  const send = options.fetch ?? fetch;
  return {
    name: 'resend',
    async deliver(mail) {
      const response = await send('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: options.from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html })
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Resend 拒绝发信：HTTP ${response.status} ${detail.slice(0, 200)}`);
      }
    }
  };
}

export interface SmtpOptions {
  /** 一整串，如 smtps://user:pass@smtp.qq.com:465；给了就不看下面几个。 */
  readonly url?: string;
  readonly host?: string;
  readonly port?: number;
  /** true = 一连上就 TLS（465）；false = 明文连上再 STARTTLS（587/25）。不填按端口猜。 */
  readonly secure?: boolean;
  readonly user?: string;
  readonly pass?: string;
  readonly from: string;
}

/** 任意 SMTP（QQ/163/Gmail 应用专用密码、阿里云邮件推送……），用 nodemailer。 */
export function createSmtpTransport(options: SmtpOptions, create: typeof createTransport = createTransport): MailTransport {
  const port = options.port ?? 465;
  const transporter = options.url
    ? create(options.url)
    : create({
        host: options.host,
        port,
        secure: options.secure ?? port === 465,
        ...(options.user ? { auth: { user: options.user, pass: options.pass ?? '' } } : {}),
        // 不让一封信的内容去读本机文件或拉 URL（nodemailer 的附件能力我们用不到）
        disableFileAccess: true,
        disableUrlAccess: true
      });
  return {
    name: 'smtp',
    async deliver(mail) {
      await transporter.sendMail({ from: options.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
    }
  };
}

/**
 * 没配发信服务时：把信（含链接）打到 server 日志，开发、内网、还没申请发信服务时够用——
 * 去 `journalctl -u agent-hub-server` 里找链接。`outboxFile` 额外按行追加 JSON，e2e 从这里取链接。
 */
export function createLogTransport(log: (line: string) => void, outboxFile?: string): MailTransport {
  return {
    name: 'log',
    async deliver(mail) {
      log(`[mail] 未配置发信服务，只记日志 → ${mail.to}｜${mail.subject}\n${mail.text}`);
      if (outboxFile) appendFileSync(outboxFile, JSON.stringify({ to: mail.to, subject: mail.subject, text: mail.text, at: Date.now() }) + '\n');
    }
  };
}

/** domain 的 EmailSender：渲染中文模板，交给 transport；失败记一行日志（不含密钥）再抛出。 */
export function createAccountMailer(options: {
  transport: MailTransport;
  publicUrl: string;
  log: (line: string) => void;
  now?: () => number;
}): EmailSender {
  return {
    async send(mail) {
      const rendered = renderAccountMail(mail, { publicUrl: options.publicUrl, now: options.now?.() ?? Date.now() });
      try {
        await options.transport.deliver(rendered);
        if (options.transport.name !== 'log') log(options, `[mail] 已通过 ${options.transport.name} 发出：${mail.kind} → ${mail.to}`);
      } catch (error) {
        log(options, `[mail] 通过 ${options.transport.name} 发信失败（${mail.kind} → ${mail.to}）：${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }
  };
}

const log = (options: { log: (line: string) => void }, line: string): void => options.log(line);

export type MailEnv = (name: string) => string | null;

export interface MailSetup {
  readonly sender: EmailSender;
  /** 实际用上的那条路。 */
  readonly transport: 'smtp' | 'resend' | 'log';
  /** 启动时打一行，说明选了谁、为什么。 */
  readonly note: string;
}

/**
 * 从环境变量挑发信方式。HUB_MAIL_PROVIDER=smtp|resend|log 显式指定；不设就自动：
 * 1. SMTP —— 配了 SMTP_URL，或 SMTP_HOST；
 * 2. Resend —— 配了 RESEND_API_KEY；
 * 3. 只记日志。
 * 另外：没配 HUB_PUBLIC_URL 时一律退回只记日志——信里的链接拼不出对外地址，发出去也点不开。
 * 发件人 HUB_MAIL_FROM；SMTP 没配时退到 SMTP_USER（多数邮箱要求发件人就是登录账号）。
 */
export function mailFromEnv(options: {
  env: MailEnv;
  log: (line: string) => void;
  /** 没有 HUB_PUBLIC_URL 时日志模式下拼链接用的地址（如 http://127.0.0.1:7878）。 */
  fallbackUrl: string;
}): MailSetup {
  const { env } = options;
  const publicUrl = env('HUB_PUBLIC_URL');
  const outbox = env('HUB_MAIL_OUTBOX') ?? undefined;
  const smtpUrl = env('SMTP_URL');
  const smtpHost = env('SMTP_HOST');
  const resendKey = env('RESEND_API_KEY');
  const provider = (env('HUB_MAIL_PROVIDER') ?? '').trim().toLowerCase();
  const auto: 'smtp' | 'resend' | null = smtpUrl || smtpHost ? 'smtp' : resendKey ? 'resend' : null;
  const wanted: 'smtp' | 'resend' | null =
    provider === 'smtp' ? 'smtp' : provider === 'resend' ? 'resend' : provider === 'log' ? null : auto;
  const both = !provider && wanted === 'smtp' && resendKey ? '（同时配了 RESEND_API_KEY，按优先级用 SMTP；可用 HUB_MAIL_PROVIDER 指定）' : '';
  if (provider && !['smtp', 'resend', 'log'].includes(provider)) {
    options.log(`[mail] HUB_MAIL_PROVIDER=${provider} 不认识（只认 smtp / resend / log），按自动选择处理`);
  }
  if (provider === 'log') {
    return {
      sender: createAccountMailer({ transport: createLogTransport(options.log, outbox), publicUrl: publicUrl ?? options.fallbackUrl, log: options.log }),
      transport: 'log',
      note: '[mail] HUB_MAIL_PROVIDER=log：验证 / 重置邮件只记在日志里'
    };
  }
  if (wanted === 'smtp' && !smtpUrl && !smtpHost) {
    return logOnlyEarly(options, outbox, publicUrl, '[mail] HUB_MAIL_PROVIDER=smtp 但没配 SMTP_URL / SMTP_HOST：先只记日志');
  }
  if (wanted === 'resend' && !resendKey) {
    return logOnlyEarly(options, outbox, publicUrl, '[mail] HUB_MAIL_PROVIDER=resend 但没配 RESEND_API_KEY：先只记日志');
  }

  const logOnly = (note: string): MailSetup => ({
    sender: createAccountMailer({ transport: createLogTransport(options.log, outbox), publicUrl: publicUrl ?? options.fallbackUrl, log: options.log }),
    transport: 'log',
    note
  });

  if (!publicUrl) {
    return logOnly(
      wanted
        ? `[mail] 配了 ${wanted === 'smtp' ? 'SMTP' : 'Resend'}，但没设 HUB_PUBLIC_URL：信里的链接拼不出对外地址，先只记日志。设上 HUB_PUBLIC_URL 再重启即可真发信`
        : '[mail] 没配发信服务，也没设 HUB_PUBLIC_URL：验证 / 重置邮件只记在日志里（链接按本机地址拼）'
    );
  }
  if (wanted === 'smtp') {
    const user = env('SMTP_USER') ?? undefined;
    const from = env('HUB_MAIL_FROM') ?? (user?.includes('@') ? `agent-hub <${user}>` : null);
    if (!from) return logOnly('[mail] 配了 SMTP 但没有 HUB_MAIL_FROM（SMTP_USER 也不是邮箱）：不知道用谁的名义发，先只记日志');
    const port = env('SMTP_PORT');
    const secure = env('SMTP_SECURE');
    const transport = createSmtpTransport({
      ...(smtpUrl ? { url: smtpUrl } : { host: smtpHost ?? undefined }),
      ...(port ? { port: Number(port) } : {}),
      ...(secure ? { secure: secure === '1' || secure.toLowerCase() === 'true' } : {}),
      ...(user ? { user } : {}),
      ...(env('SMTP_PASS') ? { pass: env('SMTP_PASS') ?? '' } : {}),
      from
    });
    const where = smtpUrl ? 'SMTP_URL' : `${smtpHost}:${port ?? 465}`;
    return { sender: createAccountMailer({ transport, publicUrl, log: options.log }), transport: 'smtp', note: `[mail] 用 SMTP 发信（${where}，发件人 ${from}）${both}` };
  }
  if (wanted === 'resend') {
    const from = env('HUB_MAIL_FROM') ?? 'agent-hub <onboarding@resend.dev>';
    const transport = createResendTransport({ apiKey: resendKey ?? '', from });
    return { sender: createAccountMailer({ transport, publicUrl, log: options.log }), transport: 'resend', note: `[mail] 用 Resend 发信（发件人 ${from}）` };
  }
  return logOnly(`[mail] 没配发信服务（SMTP_URL / SMTP_HOST / RESEND_API_KEY 都没有）：验证 / 重置邮件只记在日志里，链接以 ${publicUrl} 开头`);
}

function logOnlyEarly(
  options: { log: (line: string) => void; fallbackUrl: string },
  outbox: string | undefined,
  publicUrl: string | null,
  note: string
): MailSetup {
  return {
    sender: createAccountMailer({ transport: createLogTransport(options.log, outbox), publicUrl: publicUrl ?? options.fallbackUrl, log: options.log }),
    transport: 'log',
    note
  };
}
