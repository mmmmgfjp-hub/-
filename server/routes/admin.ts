import express from 'express';
import { z } from 'zod';
import { audit, asyncHandler, HttpError } from '../http';
import { findUserByEmail, findUserById, newId, requireAdmin, type AuthUser } from '../auth';
import { allSettings, setSetting } from '../db';
import { countTrialUsage, activeSubscription } from '../services/entitlements';
import type { RouteContext } from '../context';
import { serializePayment, type PaymentRow } from './payments';
import { parseBody, subscriptionSettings } from './util';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SUBSCRIPTION_DAYS = 3650;

/**
 * Subscription expiry math lives in exactly one place: a new period starts now, or
 * immediately after the current active period ends (stacking instead of wasting days).
 */
export function addSubscription(
  ctx: RouteContext,
  opts: {
    userId: string;
    days: number;
    priceCents: number;
    createdBy: string | null;
    paymentRequestId?: string | null;
  },
): { id: string; startedAt: string; expiresAt: string } {
  const { db } = ctx;
  const current = activeSubscription(db, opts.userId);
  const now = ctx.now();
  const startMs = current ? new Date(current.expiresAt).getTime() : now.getTime();
  const startedAt = new Date(Math.max(startMs, now.getTime())).toISOString();
  const expiresAt = new Date(new Date(startedAt).getTime() + opts.days * DAY_MS).toISOString();
  const id = newId('sub');
  db.prepare(
    `INSERT INTO subscriptions (id, user_id, status, duration_days, price_cents, started_at,
       expires_at, created_by, payment_request_id, created_at)
     VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.userId,
    opts.days,
    opts.priceCents,
    startedAt,
    expiresAt,
    opts.createdBy,
    opts.paymentRequestId ?? null,
    now.toISOString(),
  );
  return { id, startedAt, expiresAt };
}

const settingsSchema = z.object({
  subscriptionPriceCents: z.number().int().min(1).max(10_000_000).optional(),
  subscriptionDays: z.number().int().min(1).max(MAX_SUBSCRIPTION_DAYS).optional(),
  subscriptionCurrency: z.string().trim().min(2).max(8).optional(),
  paymentNetwork: z.string().trim().min(2).max(80).optional(),
  paymentWallet: z.string().trim().max(160).optional(),
  paymentNotes: z.string().trim().max(600).optional(),
  trialAnalyses: z.number().int().min(0).max(100).optional(),
  instrumentAliases: z.record(z.array(z.string().trim().min(1).max(30)).max(20)).optional(),
});

function requireCustomer(db: RouteContext['db'], idOrEmail: string) {
  const byId = findUserById(db, idOrEmail);
  const row = byId ?? findUserByEmail(db, idOrEmail);
  if (!row) throw new HttpError(404, 'USER_NOT_FOUND', 'No account matches that identifier.');
  return row;
}

export function adminRouter(ctx: RouteContext): express.Router {
  const router = express.Router();
  const { db } = ctx;

  router.use(requireAdmin);

  router.get(
    '/overview',
    asyncHandler(async (_req, res) => {
      const nowIso = ctx.now().toISOString();
      db.prepare(
        `UPDATE subscriptions SET status = 'expired' WHERE status = 'active' AND expires_at <= ?`,
      ).run(nowIso);
      const counts = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM users) AS users,
             (SELECT COUNT(*) FROM users WHERE status = 'suspended') AS suspended,
             (SELECT COUNT(*) FROM users WHERE free_access = 'lifetime') AS exemptions,
             (SELECT COUNT(*) FROM subscriptions WHERE status = 'active' AND expires_at > ?) AS active_subscribers,
             (SELECT COUNT(*) FROM payment_requests WHERE status = 'pending') AS pending_payments,
             (SELECT COUNT(*) FROM payment_requests WHERE status = 'approved') AS approved_payments,
             (SELECT COUNT(*) FROM payment_requests WHERE status = 'rejected') AS rejected_payments,
             (SELECT COUNT(*) FROM analyses) AS analyses_total,
             (SELECT COUNT(*) FROM analyses WHERE status = 'success') AS analyses_success,
             (SELECT COUNT(*) FROM analyses WHERE status = 'failed') AS analyses_failed,
             (SELECT COUNT(*) FROM analyses WHERE status = 'unreadable') AS analyses_unreadable,
             (SELECT COUNT(*) FROM analyses WHERE date(created_at) = date(?)) AS analyses_today`,
        )
        .get(nowIso, nowIso) as Record<string, number>;
      const recent = db
        .prepare(
          `SELECT a.id, a.instrument, a.timeframe, a.status, a.decision, a.created_at, u.email
           FROM analyses a JOIN users u ON u.id = a.user_id
           ORDER BY a.created_at DESC LIMIT 10`,
        )
        .all();
      res.json({
        counts,
        recentAnalyses: recent,
        settings: subscriptionSettings(db),
        aiConfigured: ctx.ai.configured,
        marketProvider: ctx.market.name,
        mailConfigured: ctx.mailer.configured,
      });
    }),
  );

  router.get(
    '/users',
    asyncHandler(async (req, res) => {
      const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
      const like = `%${q.toLowerCase()}%`;
      const rows = db
        .prepare(
          `SELECT u.id, u.email, u.display_name, u.country_code, u.role, u.status, u.free_access,
                  u.email_verified, u.created_at, u.last_login_at,
                  (SELECT MAX(expires_at) FROM subscriptions
                     WHERE user_id = u.id AND status = 'active') AS active_until,
                  (SELECT COUNT(*) FROM analyses WHERE user_id = u.id AND status = 'success' AND consumes_trial = 1) AS trial_used,
                  (SELECT COUNT(*) FROM analyses WHERE user_id = u.id) AS analyses_total,
                  (SELECT COUNT(*) FROM payment_requests WHERE user_id = u.id AND status = 'pending') AS pending_payments
           FROM users u
           WHERE (? = '' OR lower(u.email) LIKE ? OR lower(COALESCE(u.display_name, '')) LIKE ?)
           ORDER BY u.created_at DESC LIMIT 100`,
        )
        .all(q, like, like) as Array<Record<string, unknown> & { id: string }>;
      const users = rows.map((row) => ({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        countryCode: row.country_code,
        role: row.role,
        status: row.status,
        freeAccess: row.free_access,
        emailVerified: row.email_verified === 1,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
        activeUntil: row.active_until,
        trialUsed: row.trial_used,
        analysesTotal: row.analyses_total,
        pendingPayments: row.pending_payments,
      }));
      res.json({ users, total: users.length, query: q });
    }),
  );

  router.post(
    '/users/:id/free-access',
    asyncHandler(async (req, res) => {
      const actor = req.user as AuthUser;
      const body = parseBody(z.object({ enabled: z.boolean(), email: z.string().optional() }), req.body);
      const target = requireCustomer(db, req.params.id);
      const value = body.enabled ? 'lifetime' : 'none';
      db.prepare(
        `UPDATE users SET free_access = ?, free_access_granted_at = ?, free_access_granted_by = ?
         WHERE id = ?`,
      ).run(value, body.enabled ? ctx.now().toISOString() : null, body.enabled ? actor.id : null, target.id);
      audit(db, {
        actorId: actor.id,
        actorEmail: actor.email,
        action: body.enabled ? 'admin.free_access_granted' : 'admin.free_access_revoked',
        targetType: 'user',
        targetId: target.id,
        meta: { email: target.email },
        ip: req.clientIp ?? null,
      });
      res.json({ ok: true, userId: target.id, freeAccess: value });
    }),
  );

  router.post(
    '/free-access-by-email',
    asyncHandler(async (req, res) => {
      const actor = req.user as AuthUser;
      const body = parseBody(
        z.object({ email: z.string().trim().email(), enabled: z.boolean() }),
        req.body,
      );
      const target = findUserByEmail(db, body.email);
      if (!target) {
        throw new HttpError(
          404,
          'USER_NOT_FOUND',
          'No registered account uses that email. The customer must register first; a free-access exemption cannot be pre-assigned to an unknown address.',
        );
      }
      const value = body.enabled ? 'lifetime' : 'none';
      db.prepare(
        `UPDATE users SET free_access = ?, free_access_granted_at = ?, free_access_granted_by = ?
         WHERE id = ?`,
      ).run(value, body.enabled ? ctx.now().toISOString() : null, body.enabled ? actor.id : null, target.id);
      audit(db, {
        actorId: actor.id,
        actorEmail: actor.email,
        action: body.enabled ? 'admin.free_access_granted' : 'admin.free_access_revoked',
        targetType: 'user',
        targetId: target.id,
        meta: { email: target.email, via: 'email' },
        ip: req.clientIp ?? null,
      });
      res.json({ ok: true, userId: target.id, email: target.email, freeAccess: value });
    }),
  );

  router.post(
    '/users/:id/status',
    asyncHandler(async (req, res) => {
      const actor = req.user as AuthUser;
      const body = parseBody(z.object({ status: z.enum(['active', 'suspended']) }), req.body);
      const target = requireCustomer(db, req.params.id);
      if (target.role === 'owner') {
        throw new HttpError(403, 'OWNER_PROTECTED', 'The owner account cannot be suspended.');
      }
      // Bumping token_version invalidates existing sessions immediately.
      db.prepare(
        `UPDATE users SET status = ?, token_version = token_version + 1 WHERE id = ?`,
      ).run(body.status, target.id);
      audit(db, {
        actorId: actor.id,
        actorEmail: actor.email,
        action: body.status === 'suspended' ? 'admin.user_suspended' : 'admin.user_reactivated',
        targetType: 'user',
        targetId: target.id,
        meta: { email: target.email },
        ip: req.clientIp ?? null,
      });
      res.json({ ok: true, userId: target.id, status: body.status });
    }),
  );

  router.get(
    '/users/:id/usage',
    asyncHandler(async (req, res) => {
      const target = requireCustomer(db, req.params.id);
      const analyses = db
        .prepare(
          `SELECT id, instrument, timeframe, status, decision, consumes_trial, error_code, created_at
           FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
        )
        .all(target.id);
      const payments = db
        .prepare(
          `SELECT * FROM payment_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
        )
        .all(target.id) as PaymentRow[];
      res.json({
        userId: target.id,
        email: target.email,
        trialUsed: countTrialUsage(db, target.id),
        analyses,
        payments: payments.map(serializePayment),
        activeSubscription: activeSubscription(db, target.id),
      });
    }),
  );

  router.get(
    '/payments',
    asyncHandler(async (req, res) => {
      const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
      const allowed = ['pending', 'approved', 'rejected', 'all'];
      const filter = allowed.includes(status) ? status : 'pending';
      const rows = db
        .prepare(
          `SELECT p.*, u.email AS user_email FROM payment_requests p
           JOIN users u ON u.id = p.user_id
           WHERE (? = 'all' OR p.status = ?)
           ORDER BY p.created_at DESC LIMIT 100`,
        )
        .all(filter, filter) as Array<PaymentRow & { user_email: string }>;
      res.json({
        items: rows.map((row) => ({ ...serializePayment(row), userEmail: row.user_email })),
        status: filter,
      });
    }),
  );

  router.get(
    '/payments/:id/screenshot',
    asyncHandler(async (req, res) => {
      const row = db
        .prepare('SELECT screenshot_mime, screenshot_data FROM payment_requests WHERE id = ?')
        .get(req.params.id) as { screenshot_mime: string | null; screenshot_data: string | null } | undefined;
      if (!row || !row.screenshot_mime || !row.screenshot_data) {
        throw new HttpError(404, 'NOT_FOUND', 'No screenshot is attached to this request.');
      }
      res.json({ mime: row.screenshot_mime, dataUrl: `data:${row.screenshot_mime};base64,${row.screenshot_data}` });
    }),
  );

  router.post(
    '/payments/:id/approve',
    asyncHandler(async (req, res) => {
      const actor = req.user as AuthUser;
      const body = parseBody(
        z.object({ days: z.number().int().min(1).max(MAX_SUBSCRIPTION_DAYS).optional(), note: z.string().trim().max(300).optional() }),
        req.body,
      );
      const payment = db
        .prepare('SELECT * FROM payment_requests WHERE id = ?')
        .get(req.params.id) as PaymentRow | undefined;
      if (!payment) throw new HttpError(404, 'NOT_FOUND', 'Payment request not found.');
      if (payment.status !== 'pending') {
        throw new HttpError(409, 'ALREADY_REVIEWED', `This request was already ${payment.status}.`);
      }
      const sub = subscriptionSettings(db);
      const days = body.days ?? sub.durationDays;
      const subscription = addSubscription(ctx, {
        userId: payment.user_id,
        days,
        priceCents: payment.amount_cents,
        createdBy: actor.id,
        paymentRequestId: payment.id,
      });
      db.prepare(
        `UPDATE payment_requests SET status = 'approved', reviewed_at = ?, reviewed_by = ?,
           review_note = ?, subscription_id = ? WHERE id = ?`,
      ).run(ctx.now().toISOString(), actor.id, body.note ?? null, subscription.id, payment.id);
      audit(db, {
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'admin.payment_approved',
        targetType: 'payment_request',
        targetId: payment.id,
        meta: { subscription, days, userId: payment.user_id },
        ip: req.clientIp ?? null,
      });
      const user = findUserById(db, payment.user_id);
      let emailDelivered = false;
      if (user) {
        const mail = await ctx.mailer.send({
          to: user.email,
          subject: 'تم تفعيل اشتراكك | Your subscription is active',
          text: `Your subscription is active until ${subscription.expiresAt}.\n\nتم تفعيل اشتراكك حتى ${subscription.expiresAt}.`,
          html: `<div style="font-family:system-ui,sans-serif"><h2 style="color:#c9a227">Ibn Al Yemen AI</h2><p>Your subscription is active from <b>${subscription.startedAt}</b> until <b>${subscription.expiresAt}</b>.</p><p dir="rtl">تم تفعيل اشتراكك من ${subscription.startedAt} حتى ${subscription.expiresAt}.</p></div>`,
        });
        emailDelivered = mail.delivered;
      }
      res.json({ ok: true, subscription, emailDelivered });
    }),
  );

  router.post(
    '/payments/:id/reject',
    asyncHandler(async (req, res) => {
      const actor = req.user as AuthUser;
      const body = parseBody(z.object({ note: z.string().trim().max(300).optional() }), req.body);
      const payment = db
        .prepare('SELECT * FROM payment_requests WHERE id = ?')
        .get(req.params.id) as PaymentRow | undefined;
      if (!payment) throw new HttpError(404, 'NOT_FOUND', 'Payment request not found.');
      if (payment.status !== 'pending') {
        throw new HttpError(409, 'ALREADY_REVIEWED', `This request was already ${payment.status}.`);
      }
      db.prepare(
        `UPDATE payment_requests SET status = 'rejected', reviewed_at = ?, reviewed_by = ?,
           review_note = ? WHERE id = ?`,
      ).run(ctx.now().toISOString(), actor.id, body.note ?? null, payment.id);
      audit(db, {
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'admin.payment_rejected',
        targetType: 'payment_request',
        targetId: payment.id,
        meta: { note: body.note ?? null, userId: payment.user_id },
        ip: req.clientIp ?? null,
      });
      const user = findUserById(db, payment.user_id);
      let emailDelivered = false;
      if (user) {
        const mail = await ctx.mailer.send({
          to: user.email,
          subject: 'لم نتمكن من التحقق من الدفعة | Payment could not be verified',
          text: `Your payment request could not be verified.${body.note ? ` Reviewer note: ${body.note}` : ''} No subscription was activated.`,
          html: `<div style="font-family:system-ui,sans-serif"><h2 style="color:#c9a227">Ibn Al Yemen AI</h2><p>We could not verify your payment request${body.note ? `: ${body.note}` : ''}. No subscription was activated.</p><p dir="rtl">لم نتمكن من التحقق من دفعتك${body.note ? `: ${body.note}` : ''}. لم يتم تفعيل أي اشتراك.</p></div>`,
        });
        emailDelivered = mail.delivered;
      }
      res.json({ ok: true, status: 'rejected', emailDelivered });
    }),
  );

  router.post(
    '/subscriptions',
    asyncHandler(async (req, res) => {
      const actor = req.user as AuthUser;
      const body = parseBody(
        z.object({
          email: z.string().trim().email().optional(),
          userId: z.string().trim().min(3).optional(),
          days: z.number().int().min(1).max(MAX_SUBSCRIPTION_DAYS),
          priceCents: z.number().int().min(0).max(10_000_000).optional(),
        }),
        req.body,
      );
      const identifier = body.userId || body.email;
      if (!identifier) throw new HttpError(422, 'VALIDATION_ERROR', 'Provide a customer email or user id.');
      const target = requireCustomer(db, identifier);
      const subscription = addSubscription(ctx, {
        userId: target.id,
        days: body.days,
        priceCents: body.priceCents ?? subscriptionSettings(db).priceCents,
        createdBy: actor.id,
      });
      audit(db, {
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'admin.subscription_created',
        targetType: 'user',
        targetId: target.id,
        meta: { subscription, days: body.days },
        ip: req.clientIp ?? null,
      });
      res.status(201).json({ ok: true, subscription, userId: target.id });
    }),
  );

  router.post(
    '/subscriptions/:id/revoke',
    asyncHandler(async (req, res) => {
      const actor = req.user as AuthUser;
      const row = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(req.params.id) as
        | { id: string; user_id: string; status: string }
        | undefined;
      if (!row) throw new HttpError(404, 'NOT_FOUND', 'Subscription not found.');
      db.prepare(`UPDATE subscriptions SET status = 'cancelled' WHERE id = ?`).run(row.id);
      audit(db, {
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'admin.subscription_revoked',
        targetType: 'subscription',
        targetId: row.id,
        meta: { userId: row.user_id },
        ip: req.clientIp ?? null,
      });
      res.json({ ok: true, status: 'cancelled' });
    }),
  );

  router.get(
    '/settings',
    asyncHandler(async (_req, res) => {
      const settings = allSettings(db);
      res.json({
        settings: {
          subscriptionPriceCents: Number(settings.subscription_price_cents) || 5000,
          subscriptionDays: Number(settings.subscription_days) || 30,
          subscriptionCurrency: settings.subscription_currency || 'USD',
          paymentNetwork: settings.payment_network || 'USDT — TRON (TRC20)',
          paymentWallet: settings.payment_wallet || '',
          paymentNotes: settings.payment_notes || '',
          trialAnalyses: Number(settings.trial_analyses) || ctx.cfg.trialAnalyses,
          instrumentAliases: (() => {
            try {
              return JSON.parse(settings.instrument_aliases) as Record<string, string[]>;
            } catch {
              return {};
            }
          })(),
        },
        environment: {
          aiConfigured: ctx.ai.configured,
          aiModel: ctx.ai.configured ? ctx.ai.model : null,
          marketProvider: ctx.market.name,
          mailConfigured: ctx.mailer.configured,
          ownerEmails: ctx.cfg.ownerEmails,
        },
      });
    }),
  );

  router.put(
    '/settings',
    asyncHandler(async (req, res) => {
      const actor = req.user as AuthUser;
      const body = parseBody(settingsSchema, req.body);
      const changed: string[] = [];
      const map: Array<[keyof typeof body, string]> = [
        ['subscriptionPriceCents', 'subscription_price_cents'],
        ['subscriptionDays', 'subscription_days'],
        ['subscriptionCurrency', 'subscription_currency'],
        ['paymentNetwork', 'payment_network'],
        ['paymentWallet', 'payment_wallet'],
        ['paymentNotes', 'payment_notes'],
        ['trialAnalyses', 'trial_analyses'],
      ];
      for (const [field, key] of map) {
        const value = body[field];
        if (value === undefined) continue;
        setSetting(db, key, String(value), actor.id);
        changed.push(key);
      }
      if (body.instrumentAliases) {
        const cleaned: Record<string, string[]> = {};
        for (const [symbol, list] of Object.entries(body.instrumentAliases)) {
          cleaned[symbol.toUpperCase()] = list.map((v) => v.trim()).filter(Boolean);
        }
        setSetting(db, 'instrument_aliases', JSON.stringify(cleaned), actor.id);
        changed.push('instrument_aliases');
      }
      audit(db, {
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'admin.settings_updated',
        targetType: 'settings',
        targetId: 'global',
        // Wallet values are never written to the audit log in full.
        meta: { changed },
        ip: req.clientIp ?? null,
      });
      res.json({ ok: true, changed, settings: subscriptionSettings(db) });
    }),
  );

  router.get(
    '/audit',
    asyncHandler(async (req, res) => {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const rows = db
        .prepare(
          `SELECT id, actor_email, action, target_type, target_id, meta_json, ip, created_at
           FROM audit_logs ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit) as Array<{ meta_json: string | null } & Record<string, unknown>>;
      res.json({
        items: rows.map((row) => ({
          ...row,
          meta: row.meta_json ? safeJson(row.meta_json) : null,
          meta_json: undefined,
        })),
      });
    }),
  );

  router.get(
    '/logs',
    asyncHandler(async (req, res) => {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const rows = db
        .prepare('SELECT id, level, event, meta_json, created_at FROM system_events ORDER BY created_at DESC LIMIT ?')
        .all(limit) as Array<{ meta_json: string | null } & Record<string, unknown>>;
      res.json({
        items: rows.map((row) => ({
          ...row,
          meta: row.meta_json ? safeJson(row.meta_json) : null,
          meta_json: undefined,
        })),
        mailConfigured: ctx.mailer.configured,
      });
    }),
  );

  return router;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
