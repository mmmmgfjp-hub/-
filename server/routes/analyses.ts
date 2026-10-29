import express from 'express';
import { z } from 'zod';
import { newId, requireAuth, type AuthUser } from '../auth';
import { audit, asyncHandler, HttpError } from '../http';
import { AiError } from '../services/ai';
import {
  INSTRUMENTS,
  TIMEFRAMES,
  sanitizeAnalysis,
  type Instrument,
  type Timeframe,
} from '../services/analysis';
import { decodeImageDataUrl } from '../services/images';
import { computeEntitlement, publicEntitlement } from '../services/entitlements';
import { MarketUnavailableError, type Quote } from '../services/market';
import type { RouteContext } from '../context';
import { instrumentAliases, parseBody } from './util';

const analyzeSchema = z.object({
  instrument: z.enum(INSTRUMENTS),
  timeframe: z.enum(TIMEFRAMES),
  image: z.string().min(100, 'Attach a chart screenshot.'),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
  clientSymbol: z.string().trim().max(40).optional(),
});

interface AnalysisRow {
  id: string;
  user_id: string;
  instrument: string;
  timeframe: string;
  status: string;
  decision: string | null;
  consumes_trial: number;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  engine: string | null;
  market_price: number | null;
  market_timestamp: string | null;
  created_at: string;
  completed_at: string | null;
  idempotency_key: string | null;
}

export function analysesRouter(ctx: RouteContext): express.Router {
  const router = express.Router();
  const { db, cfg } = ctx;

  router.post(
    '/',
    requireAuth,
    ctx.limiters.analyze,
    asyncHandler(async (req, res) => {
      const user = req.user as AuthUser;
      const body = parseBody(analyzeSchema, req.body);

      const before = computeEntitlement(db, user, cfg);
      if (!before.canAnalyze) {
        throw new HttpError(
          402,
          before.reason ?? 'QUOTA_EXHAUSTED',
          before.reason === 'SUBSCRIPTION_EXPIRED'
            ? 'Your subscription has expired. Renew to continue analysing charts.'
            : `Your ${before.trialLimit} free analyses are used. Subscribe to continue.`,
          { entitlement: publicEntitlement(before) },
        );
      }
      if (!ctx.ai.configured) {
        throw new HttpError(
          503,
          'AI_NOT_CONFIGURED',
          'Chart analysis is temporarily unavailable: the owner has not configured the AI vision provider yet. No free analysis was used.',
        );
      }

      // Duplicate-submission protection: an identical client key returns the original result.
      if (body.idempotencyKey) {
        const existing = db
          .prepare('SELECT * FROM analyses WHERE user_id = ? AND idempotency_key = ?')
          .get(user.id, body.idempotencyKey) as AnalysisRow | undefined;
        if (existing) {
          const entitlement = computeEntitlement(db, user, cfg);
          if (existing.status === 'success') {
            res.json({
              analysis: existing.result_json ? JSON.parse(existing.result_json) : null,
              status: 'success',
              replayed: true,
              entitlement: publicEntitlement(entitlement),
            });
            return;
          }
          if (existing.status === 'pending') {
            throw new HttpError(
              409,
              'ANALYSIS_IN_PROGRESS',
              'This screenshot is already being analysed. Please wait for the current request.',
            );
          }
          throw new HttpError(
            409,
            'ANALYSIS_ALREADY_ATTEMPTED',
            existing.error_code === 'QUOTA_EXHAUSTED'
              ? 'This attempt was blocked because the free quota was already used.'
              : existing.error_message || 'This screenshot already has a finished attempt.',
          );
        }
      }

      const image = decodeImageDataUrl(body.image, cfg.maxImageBytes, 'image');
      const instrument = body.instrument as Instrument;
      const timeframe = body.timeframe as Timeframe;
      const aliases = instrumentAliases(db)[instrument] ?? [];
      if (
        body.clientSymbol &&
        !aliases.some((a) => a.toLowerCase() === body.clientSymbol!.toLowerCase())
      ) {
        ctx.log('info', 'unmapped_symbol_alias', {
          instrument,
          clientSymbol: body.clientSymbol,
        });
      }

      let quote: Quote | null = null;
      let quoteWarning: string | null = null;
      try {
        quote = await ctx.market.getQuote(instrument);
      } catch (err) {
        quoteWarning =
          err instanceof MarketUnavailableError
            ? `Live reference price unavailable (${err.reason}). Analysis uses the screenshot only.`
            : 'Live reference price unavailable. Analysis uses the screenshot only.';
        ctx.log('warn', 'market_quote_failed', { instrument, reason: quoteWarning });
      }

      const id = newId('an');
      const createdAt = ctx.now().toISOString();
      db.prepare(
        `INSERT INTO analyses (id, user_id, instrument, timeframe, status, decision, consumes_trial,
           result_json, error_code, error_message, engine, market_price, market_timestamp,
           created_at, completed_at, idempotency_key)
         VALUES (?, ?, ?, ?, 'pending', NULL, 0, NULL, NULL, NULL, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        id,
        user.id,
        instrument,
        timeframe,
        ctx.ai.model,
        quote?.price ?? null,
        quote?.providerTimestamp ?? null,
        createdAt,
        body.idempotencyKey ?? null,
      );

      let model: string;
      let raw: unknown;
      try {
        const aiResult = await ctx.ai.analyzeChart({
          imageDataUrl: image.dataUrl,
          instrument,
          timeframe,
          liveQuote: quote,
        });
        model = aiResult.model;
        raw = aiResult.parsed;
      } catch (err) {
        const aiError =
          err instanceof AiError
            ? err
            : new AiError('AI_PROVIDER_ERROR', 'The analysis engine failed. Please retry.', 502);
        db.prepare(
          `UPDATE analyses SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?
           WHERE id = ?`,
        ).run(aiError.code, aiError.message.slice(0, 500), ctx.now().toISOString(), id);
        ctx.log('error', 'analysis_failed', { id, userId: user.id, code: aiError.code });
        // A failed attempt never consumes a trial.
        throw new HttpError(aiError.status, aiError.code, aiError.message, {
          entitlement: publicEntitlement(computeEntitlement(db, user, cfg)),
        });
      }

      const result = sanitizeAnalysis({ raw, instrument, timeframe, liveQuote: quote, model });
      if (quoteWarning) result.warnings.push(quoteWarning);
      if (result.priceConflict?.detected && result.priceConflict.description) {
        result.warnings.push(result.priceConflict.description);
      }

      const finalize = db.transaction(() => {
        const current = computeEntitlement(db, user, cfg);
        if (!current.canAnalyze) {
          db.prepare(
            `UPDATE analyses SET status = 'failed', error_code = 'QUOTA_EXHAUSTED',
               error_message = ?, completed_at = ? WHERE id = ?`,
          ).run('Free quota was exhausted while this analysis was running.', ctx.now().toISOString(), id);
          return { blocked: true as const, entitlement: current };
        }
        const consumesTrial = current.source === 'trial' ? 1 : 0;
        const status = result.readable ? 'success' : 'unreadable';
        db.prepare(
          `UPDATE analyses SET status = ?, decision = ?, consumes_trial = ?, result_json = ?,
             engine = ?, completed_at = ? WHERE id = ?`,
        ).run(
          status,
          result.decision,
          status === 'success' ? consumesTrial : 0,
          JSON.stringify(result),
          model,
          ctx.now().toISOString(),
          id,
        );
        audit(db, {
          actorId: user.id,
          actorEmail: user.email,
          action: status === 'success' ? 'analysis.completed' : 'analysis.unreadable',
          targetType: 'analysis',
          targetId: id,
          meta: { instrument, timeframe, decision: result.decision, consumesTrial },
          ip: req.clientIp ?? null,
        });
        return { blocked: false as const, entitlement: computeEntitlement(db, user, cfg) };
      });

      const finished = finalize();
      if (finished.blocked) {
        throw new HttpError(
          402,
          'QUOTA_EXHAUSTED',
          'Your free analyses are used. Subscribe to continue. This attempt was not charged.',
          { entitlement: publicEntitlement(finished.entitlement) },
        );
      }

      res.json({
        id,
        status: result.readable ? 'success' : 'unreadable',
        replayed: false,
        analysis: result,
        entitlement: publicEntitlement(finished.entitlement),
        trialCharged: result.readable && before.source === 'trial',
      });
    }),
  );

  router.get(
    '/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = req.user as AuthUser;
      const row = db.prepare('SELECT * FROM analyses WHERE id = ?').get(req.params.id) as
        | AnalysisRow
        | undefined;
      if (!row) throw new HttpError(404, 'NOT_FOUND', 'Analysis not found.');
      const isStaff = user.role === 'owner' || user.role === 'admin';
      if (row.user_id !== user.id && !isStaff) {
        // Do not confirm or deny existence of other customers' records.
        throw new HttpError(404, 'NOT_FOUND', 'Analysis not found.');
      }
      res.json({
        id: row.id,
        instrument: row.instrument,
        timeframe: row.timeframe,
        status: row.status,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        analysis: row.result_json ? JSON.parse(row.result_json) : null,
      });
    }),
  );

  return router;
}
