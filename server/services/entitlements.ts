import type { DB } from '../db';
import { getSetting } from '../db';
import type { AppConfig } from '../config';
import type { AuthUser } from '../auth';

export interface SubscriptionInfo {
  id: string;
  status: 'active' | 'expired' | 'cancelled';
  startedAt: string;
  expiresAt: string;
  durationDays: number;
  priceCents: number;
  daysLeft: number;
}

export type EntitlementSource = 'owner' | 'exemption' | 'subscription' | 'trial';

export interface Entitlement {
  source: EntitlementSource;
  unlimited: boolean;
  canAnalyze: boolean;
  reason: 'QUOTA_EXHAUSTED' | 'SUBSCRIPTION_EXPIRED' | null;
  trialLimit: number;
  trialUsed: number;
  trialRemaining: number;
  subscription: SubscriptionInfo | null;
}

export function trialLimit(db: DB, cfg: AppConfig): number {
  const configured = Number(getSetting(db, 'trial_analyses'));
  return Number.isFinite(configured) && configured > 0 ? configured : cfg.trialAnalyses;
}

export function countTrialUsage(db: DB, userId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM analyses
       WHERE user_id = ? AND status = 'success' AND consumes_trial = 1`,
    )
    .get(userId) as { n: number };
  return row.n;
}

function toSubscriptionInfo(row: {
  id: string;
  status: string;
  started_at: string;
  expires_at: string;
  duration_days: number;
  price_cents: number;
}): SubscriptionInfo {
  const daysLeft = Math.max(
    0,
    Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
  );
  return {
    id: row.id,
    status: row.status as SubscriptionInfo['status'],
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    durationDays: row.duration_days,
    priceCents: row.price_cents,
    daysLeft,
  };
}

/** Returns the newest active (non-expired) subscription, marking lapsed rows expired. */
export function activeSubscription(db: DB, userId: string): SubscriptionInfo | null {
  const nowIso = new Date().toISOString();
  db.prepare(
    `UPDATE subscriptions SET status = 'expired'
     WHERE user_id = ? AND status = 'active' AND expires_at <= ?`,
  ).run(userId, nowIso);
  const row = db
    .prepare(
      `SELECT * FROM subscriptions
       WHERE user_id = ? AND status = 'active' AND expires_at > ?
       ORDER BY expires_at DESC LIMIT 1`,
    )
    .get(userId, nowIso) as
    | {
        id: string;
        status: string;
        started_at: string;
        expires_at: string;
        duration_days: number;
        price_cents: number;
      }
    | undefined;
  return row ? toSubscriptionInfo(row) : null;
}

export function computeEntitlement(db: DB, user: AuthUser, cfg: AppConfig): Entitlement {
  const limit = trialLimit(db, cfg);
  const used = countTrialUsage(db, user.id);
  const subscription = activeSubscription(db, user.id);

  if (user.role === 'owner' || user.role === 'admin') {
    return {
      source: 'owner',
      unlimited: true,
      canAnalyze: true,
      reason: null,
      trialLimit: limit,
      trialUsed: used,
      trialRemaining: Math.max(0, limit - used),
      subscription,
    };
  }

  if (user.freeAccess === 'lifetime') {
    return {
      source: 'exemption',
      unlimited: true,
      canAnalyze: true,
      reason: null,
      trialLimit: limit,
      trialUsed: used,
      trialRemaining: Math.max(0, limit - used),
      subscription,
    };
  }

  if (subscription) {
    return {
      source: 'subscription',
      unlimited: true,
      canAnalyze: true,
      reason: null,
      trialLimit: limit,
      trialUsed: used,
      trialRemaining: Math.max(0, limit - used),
      subscription,
    };
  }

  const remaining = Math.max(0, limit - used);
  const hasExpiredSubscription =
    db.prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?`).get(user.id) as {
      n: number;
    };
  return {
    source: 'trial',
    unlimited: false,
    canAnalyze: remaining > 0,
    reason: remaining > 0 ? null : hasExpiredSubscription.n > 0 ? 'SUBSCRIPTION_EXPIRED' : 'QUOTA_EXHAUSTED',
    trialLimit: limit,
    trialUsed: used,
    trialRemaining: remaining,
    subscription: null,
  };
}

export function publicEntitlement(e: Entitlement) {
  return {
    source: e.source,
    unlimited: e.unlimited,
    canAnalyze: e.canAnalyze,
    reason: e.reason,
    trialLimit: e.trialLimit,
    trialUsed: e.trialUsed,
    trialRemaining: e.trialRemaining,
    subscription: e.subscription,
  };
}
