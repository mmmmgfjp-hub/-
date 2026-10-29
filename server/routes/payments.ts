import express from 'express';
import { z } from 'zod';
import { newId, requireAuth, type AuthUser } from '../auth';
import { audit, asyncHandler, HttpError } from '../http';
import { decodeImageDataUrl, validateTxHash } from '../services/images';
import { activeSubscription, computeEntitlement, publicEntitlement } from '../services/entitlements';
import type { RouteContext } from '../context';
import { parseBody, subscriptionSettings } from './util';

const submitSchema = z.object({
  txHash: z.string().trim().min(8).max(128),
  note: z.string().trim().max(500).optional(),
  screenshot: z.string().max(12_000_000).optional(),
});

export interface PaymentRow {
  id: string;
  user_id: string;
  amount_cents: number;
  currency: string;
  network: string;
  wallet_address: string;
  tx_hash: string;
  screenshot_mime: string | null;
  screenshot_data: string | null;
  note: string | null;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  subscription_id: string | null;
}

export function serializePayment(row: PaymentRow) {
  return {
    id: row.id,
    amountCents: row.amount_cents,
    currency: row.currency,
    network: row.network,
    walletAddress: row.wallet_address,
    txHash: row.tx_hash,
    hasScreenshot: Boolean(row.screenshot_mime),
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    subscriptionId: row.subscription_id,
  };
}

export function paymentsRouter(ctx: RouteContext): express.Router {
  const router = express.Router();
  const { db, cfg } = ctx;

  router.get(
    '/settings',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = req.user as AuthUser;
      const sub = subscriptionSettings(db);
      const pending = db
        .prepare(
          `SELECT id, status, amount_cents, currency, tx_hash, created_at
           FROM payment_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
        )
        .all(user.id);
      res.json({
        subscription: sub,
        entitlement: publicEntitlement(computeEntitlement(db, user, cfg)),
        activeSubscription: activeSubscription(db, user.id),
        requests: pending,
        // Honest disclosure: no blockchain confirmation API is integrated.
        reviewPolicy:
          'Payments are reviewed manually by the owner. Submitting a transaction hash or a screenshot does not prove payment; access is granted only after the owner verifies the transfer on-chain.',
        acceptsCryptoOnly: true,
        restrictions:
          'The only supported payment rail is USDT on TRON (TRC20). TRC20 transfers are not available from every exchange or country, and some banks or regulators restrict crypto payments. If you cannot pay with USDT-TRC20, contact the owner before sending anything.',
      });
    }),
  );

  router.post(
    '/',
    requireAuth,
    ctx.limiters.payments,
    asyncHandler(async (req, res) => {
      const user = req.user as AuthUser;
      const body = parseBody(submitSchema, req.body);
      const sub = subscriptionSettings(db);

      if (!sub.walletConfigured) {
        throw new HttpError(
          409,
          'WALLET_NOT_CONFIGURED',
          'Payments are temporarily closed: the owner has not configured a receiving wallet address yet. Do not send funds to any address you have not verified with the owner.',
        );
      }

      const existingPending = db
        .prepare(
          `SELECT id, created_at FROM payment_requests WHERE user_id = ? AND status = 'pending' LIMIT 1`,
        )
        .get(user.id) as { id: string; created_at: string } | undefined;
      if (existingPending) {
        throw new HttpError(
          409,
          'PAYMENT_ALREADY_PENDING',
          'You already have a payment request awaiting review. Duplicate submissions are blocked; the owner will review the existing request first.',
          { requestId: existingPending.id, createdAt: existingPending.created_at },
        );
      }

      const txHash = validateTxHash(body.txHash, sub.network);
      const duplicate = db
        .prepare('SELECT user_id FROM payment_requests WHERE tx_hash = ?')
        .get(txHash) as { user_id: string } | undefined;
      if (duplicate) {
        ctx.log('warn', 'payment_tx_reused', { userId: user.id, txHash });
        throw new HttpError(
          409,
          'TX_ALREADY_SUBMITTED',
          'This transaction hash has already been submitted. If you believe this is an error, contact the owner.',
        );
      }

      let screenshotMime: string | null = null;
      let screenshotData: string | null = null;
      if (body.screenshot) {
        const image = decodeImageDataUrl(body.screenshot, Math.min(cfg.maxImageBytes, 5 * 1024 * 1024), 'screenshot');
        screenshotMime = image.mime;
        screenshotData = image.buffer.toString('base64');
      }

      const id = newId('pay');
      const now = ctx.now().toISOString();
      db.prepare(
        `INSERT INTO payment_requests (id, user_id, amount_cents, currency, network, wallet_address,
           tx_hash, screenshot_mime, screenshot_data, note, status, created_at, reviewed_at,
           reviewed_by, review_note, subscription_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL)`,
      ).run(
        id,
        user.id,
        sub.priceCents,
        sub.currency,
        sub.network,
        sub.wallet,
        txHash,
        screenshotMime,
        screenshotData,
        body.note?.trim() || null,
        now,
      );

      audit(db, {
        actorId: user.id,
        actorEmail: user.email,
        action: 'payment.submitted',
        targetType: 'payment_request',
        targetId: id,
        meta: { amountCents: sub.priceCents, currency: sub.currency, network: sub.network },
        ip: req.clientIp ?? null,
      });
      ctx.log('info', 'payment_pending_review', { id, userId: user.id });

      const result = await ctx.mailer.send({
        to: user.email,
        subject: 'تم استلام طلب الاشتراك | Subscription request received',
        text: `We received your payment request (${id}) for review. Access is granted only after the owner verifies the transfer on-chain.\n\nاستلمنا طلبك وسيتم مراجعته يدويًا.`,
        html: `<div style="font-family:system-ui,sans-serif"><h2 style="color:#c9a227">Ibn Al Yemen AI</h2><p>We received your payment request <code>${id}</code>. It is pending manual review — a screenshot does not confirm payment.</p><p dir="rtl">تم استلام طلب الاشتراك الخاص بك، وسيتم التحقق من التحويل ومراجعته يدويًا قبل تفعيل الاشتراك.</p></div>`,
      });

      res.status(201).json({
        ok: true,
        request: {
          id,
          status: 'pending',
          amountCents: sub.priceCents,
          currency: sub.currency,
          network: sub.network,
          createdAt: now,
        },
        emailDelivered: result.delivered,
        message:
          'Your payment request is pending manual review. Access activates only after the owner verifies the transfer on-chain.',
      });
    }),
  );

  router.get(
    '/',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = req.user as AuthUser;
      const rows = db
        .prepare(
          `SELECT * FROM payment_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
        )
        .all(user.id) as PaymentRow[];
      res.json({ items: rows.map(serializePayment) });
    }),
  );

  return router;
}
