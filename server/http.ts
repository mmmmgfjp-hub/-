import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { DB } from './db';

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

export function notFoundHandler(req: Request, res: Response): void {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Endpoint not found.' });
    return;
  }
  res.status(404).send('Not found');
}

export function errorHandler(logEvent: (event: string, meta: unknown) => void) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
      return;
    }
    const anyErr = err as { type?: string; message?: string; status?: number };
    if (anyErr?.type === 'entity.too.large') {
      res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'Uploaded data is too large.' });
      return;
    }
    logEvent('unhandled_error', { path: req.path, message: anyErr?.message });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'An unexpected server error occurred. Please try again.',
    });
  };
}

export function logSystemEvent(db: DB) {
  const stmt = db.prepare(
    'INSERT INTO system_events (level, event, meta_json, created_at) VALUES (?, ?, ?, ?)',
  );
  return (level: string, event: string, meta: unknown = null): void => {
    try {
      stmt.run(level, event, meta === null ? null : JSON.stringify(meta), new Date().toISOString());
    } catch {
      /* never let logging break a request */
    }
  };
}

export function audit(
  db: DB,
  entry: {
    actorId?: string | null;
    actorEmail?: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    meta?: unknown;
    ip?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO audit_logs (actor_id, actor_email, action, target_type, target_id, meta_json, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.actorId ?? null,
    entry.actorEmail ?? null,
    entry.action,
    entry.targetType ?? null,
    entry.targetId ?? null,
    entry.meta === undefined ? null : JSON.stringify(entry.meta),
    entry.ip ?? null,
    new Date().toISOString(),
  );
}

const jsonMessage = (code: string, message: string) => ({ error: code, message });

export function buildRateLimiters(disabled = false) {
  const noop = (_req: Request, _res: Response, next: NextFunction) => next();
  if (disabled) {
    return { auth: noop, analyze: noop, payments: noop, general: noop };
  }
  return {
    auth: rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 25,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: jsonMessage('RATE_LIMITED', 'Too many authentication attempts. Try again later.'),
    }),
    analyze: rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: 20,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req: Request) => String(req.user?.id || req.ip || 'anon'),
      message: jsonMessage('RATE_LIMITED', 'Analysis rate limit reached. Try again later.'),
    }),
    payments: rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: 8,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req: Request) => String(req.user?.id || req.ip || 'anon'),
      message: jsonMessage('RATE_LIMITED', 'Too many payment submissions. Try again later.'),
    }),
    general: rateLimit({
      windowMs: 60 * 1000,
      limit: 240,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: jsonMessage('RATE_LIMITED', 'Too many requests. Please slow down.'),
    }),
  };
}
