import express from 'express';
import { z } from 'zod';
import { findUserById, requireAuth, toAuthUser, type AuthUser } from '../auth';
import { audit, asyncHandler, HttpError } from '../http';
import { isValidCountryCode, normalizeCountryCode, getCountry } from '../services/countries';
import { activeSubscription, computeEntitlement, publicEntitlement } from '../services/entitlements';
import type { RouteContext } from '../context';
import {
  bootstrapPayload,
  countryRules,
  nextCountryChangeAt,
  parseBody,
  serializeUser,
  subscriptionSettings,
} from './util';

const profileSchema = z.object({
  displayName: z.string().trim().max(80).nullable().optional(),
});

export function accountRouter(ctx: RouteContext): express.Router {
  const router = express.Router();
  const { db } = ctx;

  router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.json(bootstrapPayload(ctx, req.user as AuthUser));
    }),
  );

  router.get(
    '/profile',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = req.user as AuthUser;
      const history = db
        .prepare(
          `SELECT id, status, duration_days, price_cents, started_at, expires_at, created_at
           FROM subscriptions WHERE user_id = ? ORDER BY expires_at DESC LIMIT 20`,
        )
        .all(user.id);
      const usage = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM analyses WHERE user_id = ?) AS total_requests,
             (SELECT COUNT(*) FROM analyses WHERE user_id = ? AND status = 'success') AS successful,
             (SELECT COUNT(*) FROM analyses WHERE user_id = ? AND status = 'failed') AS failed,
             (SELECT COUNT(*) FROM payment_requests WHERE user_id = ? AND status = 'pending') AS pending_payments`,
        )
        .get(user.id, user.id, user.id, user.id) as {
        total_requests: number;
        successful: number;
        failed: number;
        pending_payments: number;
      };
      res.json({
        user: serializeUser(db, user),
        entitlement: publicEntitlement(computeEntitlement(db, user, ctx.cfg)),
        subscription: activeSubscription(db, user.id),
        subscriptionHistory: history,
        countryRules: countryRules(user),
        usage,
        subscriptionSettings: subscriptionSettings(db),
      });
    }),
  );

  router.patch(
    '/profile',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = req.user as AuthUser;
      const body = parseBody(profileSchema, req.body);
      if (body.displayName !== undefined) {
        db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(
          body.displayName?.trim() || null,
          user.id,
        );
        audit(db, {
          actorId: user.id,
          actorEmail: user.email,
          action: 'account.profile_updated',
          targetType: 'user',
          targetId: user.id,
          ip: req.clientIp ?? null,
        });
      }
      const freshRow = findUserById(db, user.id);
      const fresh = freshRow ? toAuthUser(freshRow) : user;
      res.json({ user: serializeUser(db, fresh) });
    }),
  );

  router.post(
    '/country',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = req.user as AuthUser;
      const body = parseBody(z.object({ countryCode: z.string().trim().length(2) }), req.body);
      const code = normalizeCountryCode(body.countryCode);
      if (!isValidCountryCode(code)) {
        throw new HttpError(422, 'INVALID_COUNTRY', 'Select a country from the provided list.');
      }
      if (user.countryCode === code) {
        res.json({
          ok: true,
          unchanged: true,
          user: serializeUser(db, user),
          countryRules: countryRules(user),
        });
        return;
      }
      // Security rule: a self-reported country may change at most once per cooldown window,
      // unless the account is an owner/admin correcting a configuration mistake.
      const isAdmin = user.role === 'owner' || user.role === 'admin';
      const lockedUntil = nextCountryChangeAt(user);
      if (!isAdmin && lockedUntil) {
        throw new HttpError(
          403,
          'COUNTRY_CHANGE_LOCKED',
          `Country can be changed once every ${countryRules(user).cooldownDays} days. Next change allowed after ${lockedUntil}.`,
          { nextChangeAllowedAt: lockedUntil },
        );
      }
      const now = ctx.now().toISOString();
      db.prepare(
        `UPDATE users SET country_code = ?, country_updated_at = ?, country_change_count = country_change_count + 1
         WHERE id = ?`,
      ).run(code, now, user.id);
      audit(db, {
        actorId: user.id,
        actorEmail: user.email,
        action: 'account.country_changed',
        targetType: 'user',
        targetId: user.id,
        meta: { from: user.countryCode, to: code, selfReported: true },
        ip: req.clientIp ?? null,
      });
      const freshRow = findUserById(db, user.id);
      const updated = freshRow ? toAuthUser(freshRow) : { ...user, countryCode: code };
      res.json({
        ok: true,
        user: serializeUser(db, updated),
        country: getCountry(code),
        countryRules: countryRules(updated),
      });
    }),
  );

  router.get(
    '/analyses',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = req.user as AuthUser;
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
      const rows = db
        .prepare(
          `SELECT id, instrument, timeframe, status, decision, consumes_trial, created_at, completed_at
           FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(user.id, limit);
      res.json({ items: rows, entitlement: publicEntitlement(computeEntitlement(db, user, ctx.cfg)) });
    }),
  );

  return router;
}
