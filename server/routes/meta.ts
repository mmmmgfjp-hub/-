import express from 'express';
import { requireAuth, type AuthUser } from '../auth';
import { asyncHandler, HttpError } from '../http';
import { countriesPayload } from '../services/countries';
import { MarketUnavailableError } from '../services/market';
import type { RouteContext } from '../context';
import { INSTRUMENTS } from '../services/analysis';
import { bootstrapPayload, instrumentsPayload, publicConfig } from './util';

export function metaRouter(ctx: RouteContext): express.Router {
  const router = express.Router();
  const { db, cfg } = ctx;

  router.get(
    '/health',
    asyncHandler(async (_req, res) => {
      let dbOk = true;
      try {
        db.prepare('SELECT 1').get();
      } catch {
        dbOk = false;
      }
      res.status(dbOk ? 200 : 503).json({
        ok: dbOk,
        status: dbOk ? 'healthy' : 'degraded',
        time: ctx.now().toISOString(),
        version: '1.0.0',
        dependencies: {
          database: dbOk ? 'ok' : 'error',
          ai: ctx.ai.configured ? 'configured' : 'not_configured',
          market: ctx.market.name,
          email: ctx.mailer.configured ? 'configured' : 'not_configured',
        },
      });
    }),
  );

  router.get(
    '/config',
    asyncHandler(async (_req, res) => {
      res.json(publicConfig(ctx));
    }),
  );

  router.get(
    '/instruments',
    asyncHandler(async (_req, res) => {
      res.json(instrumentsPayload(db));
    }),
  );

  router.get(
    '/countries',
    asyncHandler(async (req, res) => {
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const countries = countriesPayload(q);
      res.json({ countries, total: countries.length, source: 'i18n-iso-countries (ISO 3166-1)' });
    }),
  );

  router.get(
    '/bootstrap',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = req.user as AuthUser;
      res.json({ ok: true, ...bootstrapPayload(ctx, user) });
    }),
  );

  router.get(
    '/market/quote',
    asyncHandler(async (req, res) => {
      const raw = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : 'XAUUSD';
      const symbol = raw.toUpperCase();
      if (!(INSTRUMENTS as readonly string[]).includes(symbol)) {
        throw new HttpError(
          400,
          'UNSUPPORTED_SYMBOL',
          `Live pricing is only available for: ${INSTRUMENTS.join(', ')}.`,
        );
      }
      try {
        const quote = await ctx.market.getQuote(symbol);
        res.json({
          ok: true,
          quote,
          disclaimer:
            'Prices come from the configured external provider and may be delayed. They are reference data, not an executable broker quote.',
        });
      } catch (err) {
        const cached = ctx.market.lastCached(symbol);
        if (err instanceof MarketUnavailableError) {
          res.status(503).json({
            ok: false,
            error: 'MARKET_UNAVAILABLE',
            message:
              'The live price provider is unavailable right now. No price is being displayed instead of showing an outdated or simulated number.',
            provider: err.provider,
            lastQuote: cached ? { ...cached, stale: true } : null,
            retryAfterSeconds: 30,
          });
          return;
        }
        throw err;
      }
    }),
  );

  return router;
}

export function missingPageHandler(cfgUrl: string) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: `No API route matches ${req.method} ${req.path}.`,
      });
      return;
    }
    // SPA deep links are handled by the static shell; this is only a fallback.
    res.redirect(302, cfgUrl);
    void next;
  };
}
