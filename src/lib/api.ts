/**
 * Single API client for the browser. Every call goes to the same origin under /api,
 * sends the httpOnly session cookie, and normalises server errors into ApiError.
 * No secret ever reaches this file: the AI/market keys live only on the server.
 */

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** Vision analysis legitimately takes a while; it gets its own budget. */
export const ANALYSIS_TIMEOUT_MS = 110_000;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    const aborted = controller.signal.aborted;
    throw new NetworkError(
      aborted
        ? 'The request timed out. Your connection may be slow — please retry.'
        : 'The server could not be reached. Check your connection and retry.',
    );
  } finally {
    window.clearTimeout(timer);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const record = (payload ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(
      response.status,
      record.error || 'ERROR',
      record.message || `Request failed with status ${response.status}.`,
      record.details,
    );
  }

  return (payload ?? {}) as T;
}

export const api = {
  get: <T>(path: string, timeoutMs?: number) => request<T>(path, { timeoutMs }),
  post: <T>(path: string, body?: unknown, timeoutMs?: number) =>
    request<T>(path, { method: 'POST', body, timeoutMs }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
};

/* ---------- shared types mirrored from the server contracts ---------- */

export type Role = 'customer' | 'admin' | 'owner';
export type EntitlementSource = 'owner' | 'exemption' | 'subscription' | 'trial';

export interface CountryInfo {
  code: string;
  nameAr: string;
  nameEn: string;
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  role: Role;
  status: 'active' | 'suspended';
  emailVerified: boolean;
  freeAccess: 'none' | 'lifetime';
  country: CountryInfo | null;
  countryUpdatedAt: string | null;
  countryChangeCount: number;
  createdAt: string;
}

export interface SubscriptionInfo {
  id: string;
  status: 'active' | 'expired' | 'cancelled';
  startedAt: string;
  expiresAt: string;
  durationDays: number;
  priceCents: number;
  daysLeft: number;
}

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

export interface PublicConfig {
  appName: string;
  appVersion: string;
  trialAnalyses: number;
  subscription: { priceCents: number; currency: string; durationDays: number };
  payment: { network: string; walletConfigured: boolean; notes: string };
  ai: { configured: boolean };
  market: { provider: string };
  email: { configured: boolean; requireVerification: boolean };
  countryChangeCooldownDays: number;
}

export interface CountryRules {
  selfReported: boolean;
  cooldownDays: number;
  canChangeNow: boolean;
  nextChangeAllowedAt: string | null;
  disclosure: string;
}

export interface Bootstrap {
  user: SessionUser;
  entitlement: Entitlement;
  countryRules: CountryRules;
  config: PublicConfig;
}

export interface Quote {
  symbol: string;
  price: number;
  provider: string;
  providerTimestamp: string | null;
  fetchedAt: string;
  quality: 'live' | 'delayed' | 'stale';
  delayed: boolean;
  note: string;
}

export interface InstrumentMeta {
  symbol: string;
  label: string;
  aliases: string[];
}

export interface InstrumentsPayload {
  instruments: InstrumentMeta[];
  timeframes: string[];
}

export interface Target {
  label: 'TP1' | 'TP2' | 'TP3';
  price: number;
  riskReward: number | null;
}

export interface AnalysisResult {
  instrument: string;
  timeframe: string;
  generatedAt: string;
  readable: boolean;
  unreadableReason: string | null;
  detectedSymbol: string | null;
  chartLastPrice: number | null;
  marketContext: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  decision: 'BUY' | 'SELL' | 'CONDITIONAL_BUY' | 'CONDITIONAL_SELL' | 'NO_TRADE';
  setupType: string | null;
  entryType: 'market' | 'zone' | null;
  entry: number | null;
  entryZone: { low: number; high: number } | null;
  stopLoss: number | null;
  targets: Target[];
  supportLevels: number[];
  resistanceLevels: number[];
  reasons: string[];
  invalidation: string[];
  warnings: string[];
  confidence: 'low' | 'medium' | 'high' | null;
  riskRewardNote: string | null;
  livePrice: {
    price: number;
    provider: string;
    providerTimestamp: string | null;
    fetchedAt: string;
    quality: string;
    delayed: boolean;
    note: string;
  } | null;
  priceConflict: { detected: boolean; differencePct: number; description: string } | null;
  sanitizationNotes: string[];
  dataSources: string[];
  model: string;
}

export interface AnalysisRecord {
  id: string;
  instrument: string;
  timeframe: string;
  status: 'pending' | 'success' | 'unreadable' | 'failed';
  createdAt: string;
  completedAt: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  analysis: AnalysisResult | null;
  decision?: string | null;
  consumes_trial?: number;
}

export interface AnalyzeResponse {
  id: string;
  status: 'success' | 'unreadable';
  replayed: boolean;
  analysis: AnalysisResult;
  entitlement: Entitlement;
  trialCharged: boolean;
}

export interface HistoryItem {
  id: string;
  instrument: string;
  timeframe: string;
  status: string;
  decision: string | null;
  consumes_trial: number;
  created_at: string;
  completed_at: string | null;
}

export interface PaymentRequestItem {
  id: string;
  amountCents: number;
  currency: string;
  network: string;
  walletAddress: string;
  txHash: string;
  hasScreenshot: boolean;
  note: string | null;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  userEmail?: string;
}

export interface PaymentSettings {
  subscription: {
    priceCents: number;
    currency: string;
    durationDays: number;
    network: string;
    wallet: string;
    walletConfigured: boolean;
    notes: string;
  };
  entitlement: Entitlement;
  activeSubscription: SubscriptionInfo | null;
  requests: PaymentRequestItem[];
  reviewPolicy: string;
  acceptsCryptoOnly: boolean;
  restrictions: string;
}

export interface ProfilePayload {
  user: SessionUser;
  entitlement: Entitlement;
  subscription: SubscriptionInfo | null;
  subscriptionHistory: Array<{
    id: string;
    status: string;
    duration_days: number;
    price_cents: number;
    started_at: string;
    expires_at: string;
    created_at: string;
  }>;
  countryRules: CountryRules;
  usage: { total_requests: number; successful: number; failed: number; pending_payments: number };
  subscriptionSettings: {
    priceCents: number;
    currency: string;
    durationDays: number;
    network: string;
    wallet: string;
    walletConfigured: boolean;
    notes: string;
  };
}

export interface AdminOverview {
  counts: Record<string, number>;
  recentAnalyses: Array<{
    id: string;
    instrument: string;
    timeframe: string;
    status: string;
    decision: string | null;
    created_at: string;
    email: string;
  }>;
  settings: PaymentSettings['subscription'];
  aiConfigured: boolean;
  marketProvider: string;
  mailConfigured: boolean;
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  countryCode: string | null;
  role: Role;
  status: string;
  freeAccess: string;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  activeUntil: string | null;
  trialUsed: number;
  analysesTotal: number;
  pendingPayments: number;
}

export interface AdminSettings {
  settings: {
    subscriptionPriceCents: number;
    subscriptionDays: number;
    subscriptionCurrency: string;
    paymentNetwork: string;
    paymentWallet: string;
    paymentNotes: string;
    trialAnalyses: number;
    instrumentAliases: Record<string, string[]>;
  };
  environment: {
    aiConfigured: boolean;
    aiModel: string | null;
    marketProvider: string;
    mailConfigured: boolean;
    ownerEmails: string[];
  };
}
