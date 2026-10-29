import path from 'node:path';

/**
 * Central configuration. Every secret is read from the server environment only.
 * Nothing here is ever shipped to the browser bundle.
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  appUrl: string;
  dbPath: string;
  dataDir: string;
  ownerEmails: string[];
  cookieSecure: boolean;
  sessionSecret: string | null;
  requireEmailVerification: boolean;
  trialAnalyses: number;
  maxImageBytes: number;
  ai: {
    apiKey: string | null;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    structuredMode: 'json_schema' | 'json_object' | 'prompt';
  };
  market: {
    provider: 'auto' | 'gold-api' | 'twelvedata';
    twelveDataKey: string | null;
    cacheTtlMs: number;
    staleAfterMs: number;
  };
  mail: {
    resendApiKey: string | null;
    from: string;
  };
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV || 'development';
  const dataDir = env.DATA_DIR || path.join(process.cwd(), 'data');
  const appUrl = (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const ownerEmails = (env.OWNER_EMAIL || env.OWNER_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  return {
    nodeEnv,
    port: Number(env.PORT) || 3000,
    appUrl,
    dataDir,
    dbPath: env.DB_PATH || path.join(dataDir, 'ibn-al-yemen.db'),
    ownerEmails,
    cookieSecure: bool(env.COOKIE_SECURE, appUrl.startsWith('https://')),
    sessionSecret: env.SESSION_SECRET || null,
    requireEmailVerification: bool(env.REQUIRE_EMAIL_VERIFICATION, false),
    trialAnalyses: Number(env.TRIAL_ANALYSES) || 5,
    maxImageBytes: num(env.MAX_IMAGE_BYTES, 8 * 1024 * 1024),
    ai: {
      apiKey: env.AI_API_KEY || null,
      baseUrl: (env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      model: env.AI_MODEL || 'gpt-4o-mini',
      timeoutMs: num(env.AI_TIMEOUT_MS, 75_000),
      structuredMode: (env.AI_STRUCTURED_MODE as AppConfig['ai']['structuredMode']) || 'json_object',
    },
    market: {
      provider: (env.MARKET_PROVIDER as AppConfig['market']['provider']) || 'auto',
      twelveDataKey: env.TWELVEDATA_API_KEY || null,
      cacheTtlMs: num(env.MARKET_CACHE_TTL_MS, 20_000),
      staleAfterMs: num(env.MARKET_STALE_AFTER_MS, 90_000),
    },
    mail: {
      resendApiKey: env.RESEND_API_KEY || null,
      from: env.MAIL_FROM || 'Ibn Al Yemen AI <no-reply@localhost>',
    },
  };
}
