import type { AppConfig } from '../config';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailResult {
  delivered: boolean;
  error?: string;
}

export interface Mailer {
  configured: boolean;
  provider: string;
  send(message: MailMessage): Promise<MailResult>;
}

type FetchLike = typeof fetch;

/**
 * Optional transactional email. Configure RESEND_API_KEY (https://resend.com) to enable
 * self-serve email verification and password-reset delivery. Without it the server never
 * pretends an email was sent: it reports delivered:false and records the event server-side.
 */
export function createMailer(
  cfg: AppConfig,
  log: (level: string, event: string, meta?: unknown) => void,
  fetchImpl: FetchLike = fetch,
): Mailer {
  const configured = Boolean(cfg.mail.resendApiKey);
  return {
    configured,
    provider: configured ? 'resend' : 'none',
    async send(message: MailMessage): Promise<MailResult> {
      if (!configured) {
        log('warn', 'mail_not_configured', { to: message.to, subject: message.subject });
        return { delivered: false, error: 'EMAIL_NOT_CONFIGURED' };
      }
      try {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${cfg.mail.resendApiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: cfg.mail.from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => '')).slice(0, 300);
          log('error', 'mail_send_failed', { status: res.status, detail });
          return { delivered: false, error: `PROVIDER_ERROR_${res.status}` };
        }
        return { delivered: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        log('error', 'mail_send_exception', { message: msg });
        return { delivered: false, error: 'NETWORK_ERROR' };
      }
    },
  };
}

export function verificationEmail(appName: string, link: string): MailMessage['html'] {
  return `<div style="font-family:system-ui,sans-serif;background:#08080b;color:#f5f2e8;padding:24px">
    <h2 style="color:#d4af37;margin:0 0 12px">${appName}</h2>
    <p>Confirm your email address to complete your registration.</p>
    <p><a href="${link}" style="display:inline-block;background:#d4af37;color:#0a0a0a;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">Verify email</a></p>
    <p style="color:#9a9a9a;font-size:12px">This link expires in 24 hours. If you did not create an account, ignore this message.</p>
  </div>`;
}

export function resetEmail(appName: string, link: string): MailMessage['html'] {
  return `<div style="font-family:system-ui,sans-serif;background:#08080b;color:#f5f2e8;padding:24px">
    <h2 style="color:#d4af37;margin:0 0 12px">${appName}</h2>
    <p>Use the button below to set a new password.</p>
    <p><a href="${link}" style="display:inline-block;background:#d4af37;color:#0a0a0a;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">Reset password</a></p>
    <p style="color:#9a9a9a;font-size:12px">This link expires in 60 minutes. If you did not request it, ignore this message.</p>
  </div>`;
}
