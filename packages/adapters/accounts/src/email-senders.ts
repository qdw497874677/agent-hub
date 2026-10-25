import type { EmailSender } from '@agent-hub/domain';

/**
 * Resend（https://resend.com/docs/api-reference/emails/send-email）。
 * 整个 API 就一个 POST，直接用 fetch，不为它多装一个 SDK。
 */
export function createResendSender(options: { apiKey: string; from: string; fetch?: typeof fetch }): EmailSender {
  const send = options.fetch ?? fetch;
  return {
    async send(email) {
      const response = await send('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: options.from, to: [email.to], subject: email.subject, text: email.text })
      });
      if (!response.ok) throw new Error(`Resend 拒绝发信：HTTP ${response.status}`);
    }
  };
}

/** 没配 RESEND_API_KEY 时：只把信的内容打到 server 日志，开发与内网够用。 */
export function createLogSender(log: (line: string) => void): EmailSender {
  return {
    async send(email) {
      log(`[mail] 未配置发信服务，只记日志 → ${email.to}｜${email.subject}｜${email.text}`);
    }
  };
}
