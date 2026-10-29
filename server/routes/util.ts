import type { z, ZodTypeAny } from 'zod';
import type { AuthUser } from '../auth';
import type { DB } from '../db';
import { getSetting } from '../db';
import { HttpError } from '../http';
import { getCountry } from '../services/countries';
import { publicEntitlement, trialLimit, computeEntitlement } from '../services/entitlements';
import type { RouteContext } from '../context';
import { INSTRUMENTS, INSTRUMENT_LABELS, TIMEFRAMES } from '../services/analysis';

export function parseBody<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.join('.') || 'body';
    throw new HttpError(
      422,
      'VALIDATION_ERROR',
      `${path}: ${issue?.message ?? 'Invalid input.'}`,
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export function serializeUser(db: DB, user: AuthUser) {
  const country = getCountry(user.countryCode);
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    emailVerified: user.emailVerified,
    freeAccess: user.freeAccess,
    country: country
      ? { code: country.code, nameAr: country.nameAr, nameEn: country.nameEn }
      : null,
    countryUpdatedAt: user.countryUpdatedAt,
    countryChangeCount: user.countryChangeCount,
    createdAt: user.createdAt,
  };
}

const COUNTRY_CHANGE_COOLDOWN_DAYS = 30;

export function nextCountryChangeAt(user: AuthUser): string | null {
  if (!user.countryUpdatedAt) return null;
  const last = new Date(user.countryUpdatedAt).getTime();
  if (!Number.isFinite(last)) return null;
  const next = new Date(last + COUNTRY_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  return next.getTime() <= Date.now() ? null : next.toISOString();
}

export function countryRules(user: AuthUser) {
  const next = nextCountryChangeAt(user);
  return {
    selfReported: true,
    cooldownDays: COUNTRY_CHANGE_COOLDOWN_DAYS,
    canChangeNow: next === null,
    nextChangeAllowedAt: next,
    disclosure:
      'Country is self-reported from a maintained ISO 3166-1 list. It is not a verified residence and does not unlock restricted services.',
  };
}

export function subscriptionSettings(db: DB) {
  const priceCents = Number(getSetting(db, 'subscription_price_cents')) || 5000;
  const days = Number(getSetting(db, 'subscription_days')) || 30;
  const currency = getSetting(db, 'subscription_currency') || 'USD';
  const network = getSetting(db, 'payment_network') || 'USDT — TRON (TRC20)';
  const wallet = getSetting(db, 'payment_wallet') || '';
  return {
    priceCents,
    currency,
    durationDays: days,
    network,
    wallet,
    walletConfigured: wallet.trim().length > 0,
    notes: getSetting(db, 'payment_notes') || '',
  };
}

export function instrumentAliases(db: DB): Record<string, string[]> {
  try {
    const parsed = JSON.parse(getSetting(db, 'instrument_aliases')) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const symbol of INSTRUMENTS) {
      const list = parsed[symbol];
      out[symbol] = Array.isArray(list)
        ? list.filter((v): v is string => typeof v === 'string')
        : [symbol];
    }
    return out;
  } catch {
    const out: Record<string, string[]> = {};
    for (const symbol of INSTRUMENTS) out[symbol] = [symbol];
    return out;
  }
}

export function publicConfig(ctx: RouteContext) {
  const sub = subscriptionSettings(ctx.db);
  return {
    appName: 'ابن اليمن | Ibn Al Yemen AI',
    appVersion: '1.0.0',
    trialAnalyses: trialLimit(ctx.db, ctx.cfg),
    subscription: {
      priceCents: sub.priceCents,
      currency: sub.currency,
      durationDays: sub.durationDays,
    },
    payment: {
      network: sub.network,
      walletConfigured: sub.walletConfigured,
      notes: sub.notes,
    },
    ai: { configured: ctx.ai.configured },
    market: { provider: ctx.market.name },
    email: {
      configured: ctx.mailer.configured,
      requireVerification: ctx.cfg.requireEmailVerification,
    },
    countryChangeCooldownDays: COUNTRY_CHANGE_COOLDOWN_DAYS,
  };
}

export function instrumentsPayload(db: DB) {
  const aliases = instrumentAliases(db);
  return {
    instruments: INSTRUMENTS.map((symbol) => ({
      symbol,
      label: INSTRUMENT_LABELS[symbol],
      aliases: aliases[symbol] ?? [symbol],
    })),
    timeframes: TIMEFRAMES,
  };
}

export function bootstrapPayload(ctx: RouteContext, user: AuthUser) {
  const entitlement = computeEntitlement(ctx.db, user, ctx.cfg);
  return {
    user: serializeUser(ctx.db, user),
    entitlement: publicEntitlement(entitlement),
    countryRules: countryRules(user),
    config: publicConfig(ctx),
  };
}
