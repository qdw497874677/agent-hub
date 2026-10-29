import type { AccountMail } from '@agent-hub/domain';

/** 渲染好的一封信：纯文本 + 简单 HTML（同一份内容）。 */
export interface RenderedMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * 账号邮件的中文模板。链接用 hash 路由（`#/verify?token=…`）：
 * 令牌不进 server 的访问日志，也不会随 Referer 带去别的网站。
 * `publicUrl` 只来自配置（HUB_PUBLIC_URL），从不取请求的 Host 头，免得被人伪造成钓鱼链接。
 */
export function accountLink(publicUrl: string, kind: 'verify' | 'reset', token: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/#/${kind}?token=${encodeURIComponent(token)}`;
}

const minutesLeft = (expiresAt: number, now: number): number => Math.max(1, Math.round((expiresAt - now) / 60_000));

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);

function htmlOf(greeting: string, lines: readonly string[], action?: { label: string; href: string }): string {
  const paragraphs = lines.map((line) => `<p style="margin:0 0 12px">${escapeHtml(line)}</p>`).join('');
  const button = action
    ? `<p style="margin:20px 0"><a href="${escapeHtml(action.href)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#3b6df5;color:#fff;text-decoration:none">${escapeHtml(action.label)}</a></p>` +
      `<p style="margin:0 0 12px;color:#888;font-size:12px">按钮点不开就复制这个链接到浏览器：<br>${escapeHtml(action.href)}</p>`
    : '';
  return (
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.6;color:#222;max-width:480px">` +
    `<p style="margin:0 0 12px">${escapeHtml(greeting)}</p>${paragraphs}${button}` +
    `<p style="margin:24px 0 0;color:#888;font-size:12px">—— agent-hub</p></div>`
  );
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) + '（北京时间）';
}

export function renderAccountMail(mail: AccountMail, options: { publicUrl: string; now?: number }): RenderedMail {
  const now = options.now ?? Date.now();
  const greeting = `${mail.displayName}，你好：`;
  switch (mail.kind) {
    case 'verify-email': {
      const href = accountLink(options.publicUrl, 'verify', mail.token);
      const lines = [
        '你刚在 agent-hub 注册了账号。点下面的链接确认这是你的邮箱：',
        `链接 ${minutesLeft(mail.expiresAt, now)} 分钟内有效，只能用一次。`,
        '如果不是你本人注册的，忽略这封信即可。'
      ];
      return {
        to: mail.to,
        subject: '确认你的 agent-hub 邮箱',
        text: [greeting, '', lines[0], href, '', lines[1], lines[2]].join('\n'),
        html: htmlOf(greeting, lines, { label: '验证邮箱', href })
      };
    }
    case 'reset-password': {
      const href = accountLink(options.publicUrl, 'reset', mail.token);
      const lines = [
        '有人（希望是你）申请重置 agent-hub 的登录密码。点下面的链接设一个新密码：',
        `链接 ${minutesLeft(mail.expiresAt, now)} 分钟内有效，只能用一次；设好后其他设备会被登出。`,
        '如果不是你本人操作，忽略这封信即可，你的密码不会变。'
      ];
      return {
        to: mail.to,
        subject: '重置你的 agent-hub 密码',
        text: [greeting, '', lines[0], href, '', lines[1], lines[2]].join('\n'),
        html: htmlOf(greeting, lines, { label: '设置新密码', href })
      };
    }
    case 'password-changed': {
      const lines = [
        `你的 agent-hub 登录密码已在 ${formatTime(mail.at)} 修改，其他设备上的登录都已失效。`,
        '如果不是你本人操作，请立刻用「忘记密码」重新设置，并联系 hub 的主人。'
      ];
      return {
        to: mail.to,
        subject: 'agent-hub 密码已修改',
        text: [greeting, '', ...lines].join('\n'),
        html: htmlOf(greeting, lines)
      };
    }
  }
}
