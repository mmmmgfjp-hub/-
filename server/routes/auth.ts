import express from 'express';
import { z } from 'zod';
import {
  clearSessionCookie,
  findUserByEmail,
  findUserById,
  hashPassword,
  hashToken,
  newId,
  randomToken,
  requireAuth,
  resolveSessionSecret,
  setSessionCookie,
  signSession,
  toAuthUser,
  verifyPassword,
  type AuthUser,
} from '../auth';
import { setSetting } from '../db';
import { audit, asyncHandler, HttpError } from '../http';
import { isValidCountryCode, normalizeCountryCode, getCountry } from '../services/countries';
import { computeEntitlement, publicEntitlement } from '../services/entitlements';
import { resetEmail, verificationEmail } from '../services/email';
import type { RouteContext } from '../context';
import { bootstrapPayload, parseBody, serializeUser } from './util';

const emailSchema = z.string().trim().min(5).max(254).email('A valid email address is required.');
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(200)
  .refine((v) => /[A-Za-z]/.test(v) && /[0-9]/.test(v), 'A letter and a number are required.');

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().max(80).optional().nullable(),
  countryCode: z.string().trim().length(2, 'Pick a country from the list.'),
});

const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(200) });

const TOKEN_TTL_MS = { verify: 24 * 60 * 60 * 1000, reset: 60 * 60 * 1000 } as const;

function issueToken(ctx: RouteContext, userId: string, purpose: 'verify' | 'reset'): string {
  const token = randomToken(32);
  ctx.db
    .prepare(
      `INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at, used_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      newId('tok'),
      userId,
      purpose,
      hashToken(token),
      new Date(Date.now() + TOKEN_TTL_MS[purpose]).toISOString(),
      new Date().toISOString(),
    );
  return token;
}

interface TokenRow {
  id: string;
  user_id: string;
  purpose: string;
  expires_at: string;
  used_at: string | null;
}

function consumeToken(ctx: RouteContext, token: string, purpose: 'verify' | 'reset'): TokenRow {
  const row = ctx.db
    .prepare('SELECT * FROM email_tokens WHERE token_hash = ?')
    .get(hashToken(token)) as TokenRow | undefined;
  if (!row || row.purpose !== purpose) {
    throw new HttpError(400, 'INVALID_TOKEN', 'This link is invalid. Request a new one.');
  }
  if (row.used_at) {
    throw new HttpError(400, 'TOKEN_USED', 'This link has already been used. Request a new one.');
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new HttpError(400, 'TOKEN_EXPIRED', 'This link has expired. Request a new one.');
  }
  ctx.db
    .prepare('UPDATE email_tokens SET used_at = ? WHERE id = ?')
    .run(new Date().toISOString(), row.id);
  return row;
}

function isOwnerEmail(ctx: RouteContext, email: string): boolean {
  return ctx.cfg.ownerEmails.includes(email.trim().toLowerCase());
}

export function authRouter(ctx: RouteContext): express.Router {
  const router = express.Router();
  const { db, cfg } = ctx;

  const startSession = (res: express.Response, userRow: ReturnType<typeof findUserById>) => {
    if (!userRow) throw new HttpError(500, 'USER_MISSING', 'Account could not be loaded.');
    const token = signSession(resolveSessionSecret(db, cfg), userRow);
    setSessionCookie(res, token, cfg.cookieSecure);
  };

  router.post(
    '/register',
    ctx.limiters.auth,
    asyncHandler(async (req, res) => {
      const body = parseBody(registerSchema, req.body);
      const email = body.email.toLowerCase();
      const countryCode = normalizeCountryCode(body.countryCode);
      if (!isValidCountryCode(countryCode)) {
        throw new HttpError(422, 'INVALID_COUNTRY', 'Select a country from the provided list.');
      }
      if (findUserByEmail(db, email)) {
        throw new HttpError(409, 'EMAIL_IN_USE', 'An account with this email already exists.');
      }
      const now = ctx.now().toISOString();
      const id = newId('usr');
      const passwordHash = await hashPassword(body.password);
      const role = isOwnerEmail(ctx, email) ? 'owner' : 'customer';
      db.prepare(
        `INSERT INTO users (id, email, password_hash, display_name, country_code, country_updated_at,
           country_change_count, email_verified, role, status, free_access, token_version, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 'active', ?, 0, ?, ?)`,
      ).run(
        id,
        email,
        passwordHash,
        body.displayName?.trim() || null,
        countryCode,
        now,
        role,
        role === 'owner' ? 'lifetime' : 'none',
        now,
        now,
      );
      audit(db, {
        actorId: id,
        actorEmail: email,
        action: 'account.registered',
        targetType: 'user',
        targetId: id,
        meta: { countryCode, role },
        ip: req.clientIp ?? null,
      });

      const row = findUserById(db, id)!;
      startSession(res, row);

      let verifyDelivered: boolean | null = null;
      if (!row.email_verified) {
        const token = issueToken(ctx, id, 'verify');
        const link = `${cfg.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
        const mail = await ctx.mailer.send({
          to: email,
          subject: `تحقق من بريدك — ${'ابن اليمن AI'}`,
          html: verificationEmail('ابن اليمن AI', link),
          text: `Verify your email: ${link}`,
        });
        verifyDelivered = mail.delivered;
        ctx.log(mail.delivered ? 'info' : 'warn', 'verification_email', {
          userId: id,
          delivered: mail.delivered,
        });
      }

      const user = toAuthUser(row);
      res.status(201).json({
        ...bootstrapPayload(ctx, user),
        verification: {
          required: cfg.requireEmailVerification,
          emailDelivered: verifyDelivered,
          emailConfigured: ctx.mailer.configured,
        },
      });
    }),
  );

  router.post(
    '/login',
    ctx.limiters.auth,
    asyncHandler(async (req, res) => {
      const body = parseBody(loginSchema, req.body);
      const email = body.email.toLowerCase();
      const row = findUserByEmail(db, email);
      const generic = new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
      if (!row) throw generic;
      const ok = await verifyPassword(body.password, row.password_hash);
      if (!ok) {
        audit(db, {
          actorId: row.id,
          actorEmail: email,
          action: 'account.login_failed',
          ip: req.clientIp ?? null,
        });
        throw generic;
      }
      if (row.status === 'suspended') {
        throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended. Contact the owner.');
      }
      if (cfg.requireEmailVerification && row.email_verified !== 1) {
        throw new HttpError(
          403,
          'EMAIL_NOT_VERIFIED',
          'Verify your email address before signing in.',
        );
      }
      const now = ctx.now().toISOString();
      if (isOwnerEmail(ctx, email) && row.role === 'customer') {
        db.prepare(`UPDATE users SET role = 'owner', free_access = 'lifetime' WHERE id = ?`).run(row.id);
        audit(db, {
          actorId: row.id,
          actorEmail: email,
          action: 'account.owner_promoted',
          targetType: 'user',
          targetId: row.id,
          ip: req.clientIp ?? null,
        });
      }
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, row.id);
      const fresh = findUserById(db, row.id)!;
      startSession(res, fresh);
      audit(db, {
        actorId: row.id,
        actorEmail: email,
        action: 'account.login',
        ip: req.clientIp ?? null,
      });
      res.json(bootstrapPayload(ctx, toAuthUser(fresh)));
    }),
  );

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      if (req.user) {
        audit(db, {
          actorId: req.user.id,
          actorEmail: req.user.email,
          action: 'account.logout',
          ip: req.clientIp ?? null,
        });
      }
      clearSessionCookie(res, cfg.cookieSecure);
      res.json({ ok: true });
    }),
  );

  router.get(
    '/me',
    asyncHandler(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Not signed in.' });
        return;
      }
      res.json(bootstrapPayload(ctx, req.user));
    }),
  );

  router.post(
    '/forgot-password',
    ctx.limiters.auth,
    asyncHandler(async (req, res) => {
      const body = parseBody(z.object({ email: emailSchema }), req.body);
      const email = body.email.toLowerCase();
      const row = findUserByEmail(db, email);
      let delivered: boolean | null = null;
      if (row) {
        const token = issueToken(ctx, row.id, 'reset');
        const link = `${cfg.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
        const mail = await ctx.mailer.send({
          to: email,
          subject: 'إعادة تعيين كلمة المرور — ابن اليمن AI',
          html: resetEmail('ابن اليمن AI', link),
          text: `Reset your password: ${link}`,
        });
        delivered = mail.delivered;
        audit(db, {
          actorId: row.id,
          actorEmail: email,
          action: 'account.password_reset_requested',
          ip: req.clientIp ?? null,
          meta: { delivered },
        });
      }
      // Always the same response shape: never reveal whether an email is registered.
      res.json({
        ok: true,
        emailConfigured: ctx.mailer.configured,
        delivered: delivered === true,
        message: ctx.mailer.configured
          ? 'If that email is registered, a reset link has been sent.'
          : 'Email delivery is not configured on this deployment. Contact the owner to reset your password.',
      });
    }),
  );

  router.post(
    '/reset-password',
    ctx.limiters.auth,
    asyncHandler(async (req, res) => {
      const body = parseBody(
        z.object({ token: z.string().min(10).max(200), password: passwordSchema }),
        req.body,
      );
      const tokenRow = consumeToken(ctx, body.token, 'reset');
      const hash = await hashPassword(body.password);
      db.prepare(
        'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
      ).run(hash, tokenRow.user_id);
      db.prepare(
        `UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = 'reset' AND used_at IS NULL`,
      ).run(ctx.now().toISOString(), tokenRow.user_id);
      clearSessionCookie(res, cfg.cookieSecure);
      audit(db, {
        actorId: tokenRow.user_id,
        action: 'account.password_reset',
        targetType: 'user',
        targetId: tokenRow.user_id,
        ip: req.clientIp ?? null,
      });
      res.json({ ok: true, message: 'Password updated. Sign in with your new password.' });
    }),
  );

  router.post(
    '/verify-email',
    ctx.limiters.auth,
    asyncHandler(async (req, res) => {
      const body = parseBody(z.object({ token: z.string().min(10).max(200) }), req.body);
      const tokenRow = consumeToken(ctx, body.token, 'verify');
      db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(tokenRow.user_id);
      audit(db, {
        actorId: tokenRow.user_id,
        action: 'account.email_verified',
        targetType: 'user',
        targetId: tokenRow.user_id,
        ip: req.clientIp ?? null,
      });
      res.json({ ok: true, message: 'Email verified.' });
    }),
  );

  router.post(
    '/resend-verification',
    requireAuth,
    ctx.limiters.auth,
    asyncHandler(async (req, res) => {
      const user = req.user as AuthUser;
      if (user.emailVerified) {
        res.json({ ok: true, alreadyVerified: true, delivered: false });
        return;
      }
      const token = issueToken(ctx, user.id, 'verify');
      const link = `${cfg.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
      const mail = await ctx.mailer.send({
        to: user.email,
        subject: 'تحقق من بريدك — ابن اليمن AI',
        html: verificationEmail('ابن اليمن AI', link),
        text: `Verify your email: ${link}`,
      });
      res.json({
        ok: true,
        delivered: mail.delivered,
        emailConfigured: ctx.mailer.configured,
        message: mail.delivered
          ? 'Verification email sent.'
          : 'Email delivery is not configured on this deployment.',
      });
    }),
  );

  return router;
}

/** Used by the admin "reset link" tool and by tests. */
export function createResetLink(
  ctx: RouteContext,
  userId: string,
): { url: string; expiresAt: string } {
  const token = issueToken(ctx, userId, 'reset');
  return {
    url: `${ctx.cfg.appUrl}/reset-password?token=${encodeURIComponent(token)}`,
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS.reset).toISOString(),
  };
}

export function ensureOwnerSeed(ctx: RouteContext): void {
  // Owner role is derived from server env only; no credentials are ever hardcoded.
  if (ctx.cfg.ownerEmails.length === 0) return;
  const emails = ctx.cfg.ownerEmails;
  for (const email of emails) {
    const row = findUserByEmail(ctx.db, email);
    if (row && row.role !== 'owner') {
      ctx.db.prepare(`UPDATE users SET role = 'owner' WHERE id = ?`).run(row.id);
      ctx.log('info', 'owner_role_applied', { email });
    }
  }
  const settings = ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get('owner_seeded');
  if (!settings) {
    setSetting(ctx.db, 'owner_seeded', '1', null);
  }
}

export function entitlementSummary(ctx: RouteContext, user: AuthUser) {
  return publicEntitlement(computeEntitlement(ctx.db, user, ctx.cfg));
}

export function userCountryLabel(user: AuthUser): string | null {
  return getCountry(user.countryCode)?.nameEn ?? null;
}

export { serializeUser };
