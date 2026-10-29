import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { loadConfig } from './config';
import { openDatabase } from './db';
import { attachUser, resolveSessionSecret } from './auth';
import { buildRateLimiters, HttpError } from './http';
import { createMarketService } from './services/market';
import { createAiClient } from './services/ai';
import { createMailer } from './services/email';
import type { RouteContext } from './context';
import { authRouter, ensureOwnerSeed } from './routes/auth';
import { accountRouter } from './routes/account';
import { analysesRouter } from './routes/analyses';
import { paymentsRouter } from './routes/payments';
import { adminRouter } from './routes/admin';
import { metaRouter } from './routes/meta';

function buildContext(): { ctx: RouteContext; close: () => void } {
  const cfg = loadConfig();
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const db = openDatabase(cfg.dbPath);

  const log = (level: string, event: string, meta?: unknown): void => {
    const line = `[${level}] ${event}${meta ? ` ${JSON.stringify(meta)}` : ''}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    try {
      db.prepare(
        'INSERT INTO system_events (level, event, meta_json, created_at) VALUES (?, ?, ?, ?)',
      ).run(level, event, meta === undefined ? null : JSON.stringify(meta), new Date().toISOString());
      // Keep the operational log bounded so the database never grows without limit.
      db.prepare(
        `DELETE FROM system_events WHERE id <= (SELECT MAX(id) FROM system_events) - 5000`,
      ).run();
    } catch {
      /* logging must never break a request */
    }
  };

  const secret = resolveSessionSecret(db, cfg);
  if (!cfg.sessionSecret) {
    log('warn', 'session_secret_persisted', {
      message:
        'SESSION_SECRET is not set. A random secret was generated and stored in the database. Set SESSION_SECRET in the deployment environment for reproducible sessions across redeploys.',
    });
  }

  const ctx: RouteContext = {
    db,
    cfg,
    ai: createAiClient(cfg),
    market: createMarketService(cfg),
    mailer: createMailer(cfg, log),
    secret,
    log,
    limiters: buildRateLimiters(cfg.nodeEnv === 'test'),
    now: () => new Date(),
  };
  ensureOwnerSeed(ctx);
  return {
    ctx,
    close: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}

const { ctx, close } = buildContext();
const app = express();

// Behind the hosting proxy: trust exactly one hop so req.ip reflects the client.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "font-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  if (ctx.cfg.nodeEnv === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());
app.use('/api', ctx.limiters.general);
app.use(attachUser({ db: ctx.db, secret: ctx.secret }));

app.use('/api/auth', authRouter(ctx));
app.use('/api/account', accountRouter(ctx));
app.use('/api/analyses', analysesRouter(ctx));
app.use('/api/payments', paymentsRouter(ctx));
app.use('/api/admin', adminRouter(ctx));
app.use('/api', metaRouter(ctx));

// Static SPA shell. Only build artefacts are served; no customer data is cached.
const webDir = path.join(__dirname, '..', 'web');
const indexHtml = path.join(webDir, 'index.html');

if (fs.existsSync(indexHtml)) {
  app.use(
    express.static(webDir, {
      index: false,
      etag: true,
      setHeaders: (res, filePath) => {
        const name = path.basename(filePath);
        if (name === 'index.html' || name === 'sw.js' || name === 'manifest.webmanifest') {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (/\.[0-9a-f]{8,}\./.test(name)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=3600');
        }
      },
    }),
  );

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml, (err) => {
      if (err) next(err);
    });
  });
} else {
  ctx.log('warn', 'web_build_missing', { webDir, hint: 'Run npm run build:web before starting.' });
}

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'No API route matches this request.' });
});

app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ): void => {
    if (res.headersSent) return;
    if (err instanceof HttpError) {
      res.status(err.status).json({
        error: err.code,
        message: err.message,
        details: err.details ?? undefined,
      });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'INVALID_JSON', message: 'The request body is not valid JSON.' });
      return;
    }
    const message = err instanceof Error ? err.message : 'Unexpected error';
    ctx.log('error', 'unhandled_request_error', { path: req.path, message });
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Something went wrong on the server. Please retry; the details were logged.',
    });
  },
);

const server = app.listen(ctx.cfg.port, '0.0.0.0', () => {
  ctx.log('info', 'server_started', {
    port: ctx.cfg.port,
    env: ctx.cfg.nodeEnv,
    db: ctx.cfg.dbPath,
    // Secrets are reported as booleans only.
    aiConfigured: ctx.ai.configured,
    mailConfigured: ctx.mailer.configured,
    marketProvider: ctx.market.name,
  });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    ctx.log('info', 'shutdown', { signal });
    server.close(() => {
      close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
