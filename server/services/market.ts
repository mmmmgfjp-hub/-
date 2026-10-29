import type { AppConfig } from '../config';

export type QuoteQuality = 'reference' | 'delayed' | 'realtime';

export interface Quote {
  /** Canonical instrument symbol, e.g. XAUUSD */
  symbol: string;
  price: number;
  currency: string;
  provider: string;
  providerTimestamp: string | null;
  fetchedAt: string;
  quality: QuoteQuality;
  delayed: boolean;
  note: string;
  stale?: boolean;
}

export interface MarketService {
  readonly name: string;
  getQuote(symbol: string): Promise<Quote>;
  lastCached(symbol: string): Quote | null;
}

export class MarketUnavailableError extends Error {
  provider: string;
  reason: string;
  constructor(provider: string, reason: string) {
    super(reason);
    this.provider = provider;
    this.reason = reason;
  }
}

type FetchLike = typeof fetch;

const GOLD_API_SYMBOLS: Record<string, string> = { XAUUSD: 'XAU' };

const TWELVE_DATA_SYMBOLS: Record<string, string> = {
  XAUUSD: 'XAU/USD',
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY',
  NAS100: 'NDX',
  BTCUSD: 'BTC/USD',
};

const CURRENCY_BY_SYMBOL: Record<string, string> = {
  XAUUSD: 'USD',
  EURUSD: 'USD',
  GBPUSD: 'USD',
  USDJPY: 'JPY',
  NAS100: 'USD',
  BTCUSD: 'USD',
};

interface CacheEntry {
  quote: Quote;
  at: number;
}

/**
 * Replaceable market-data layer. Providers are chosen by config, never by the UI.
 * - gold-api: free, keyless, reference XAU spot price (indicative, not exchange-grade)
 * - twelvedata: requires API key, supports all instruments, free tier ~800 req/day & 8 req/min
 */
export function createMarketService(cfg: AppConfig, fetchImpl: FetchLike = fetch): MarketService {
  const cache = new Map<string, CacheEntry>();
  const providerName = () => {
    if (cfg.market.provider === 'auto') return cfg.market.twelveDataKey ? 'twelvedata' : 'gold-api';
    return cfg.market.provider;
  };

  const lastCached = (symbol: string): Quote | null => {
    const hit = cache.get(symbol);
    if (!hit) return null;
    const age = Date.now() - hit.at;
    return { ...hit.quote, stale: age > cfg.market.staleAfterMs };
  };

  const fetchGoldApi = async (symbol: string): Promise<Quote> => {
    const remote = GOLD_API_SYMBOLS[symbol];
    if (!remote) {
      throw new MarketUnavailableError(
        'gold-api',
        `gold-api only serves gold. Configure TWELVEDATA_API_KEY to quote ${symbol}.`,
      );
    }
    const res = await fetchImpl(`https://api.gold-api.com/price/${remote}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new MarketUnavailableError('gold-api', `Provider responded ${res.status}`);
    const body = (await res.json()) as { price?: number; updatedAt?: string };
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new MarketUnavailableError('gold-api', 'Provider returned no usable price');
    }
    return {
      symbol,
      price,
      currency: CURRENCY_BY_SYMBOL[symbol] ?? 'USD',
      provider: 'gold-api.com',
      providerTimestamp: body.updatedAt || null,
      fetchedAt: new Date().toISOString(),
      quality: 'reference',
      delayed: true,
      note:
        'Indicative reference spot price (free public feed). Not an exchange tick feed and not necessarily executable.',
    };
  };

  const fetchTwelveData = async (symbol: string): Promise<Quote> => {
    if (!cfg.market.twelveDataKey) {
      throw new MarketUnavailableError('twelvedata', 'TWELVEDATA_API_KEY is not configured.');
    }
    const remote = TWELVE_DATA_SYMBOLS[symbol];
    if (!remote) throw new MarketUnavailableError('twelvedata', `Unsupported symbol ${symbol}`);
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(remote)}&apikey=${encodeURIComponent(cfg.market.twelveDataKey)}`;
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new MarketUnavailableError('twelvedata', `Provider responded ${res.status}`);
    const body = (await res.json()) as {
      close?: string;
      price?: string;
      datetime?: string;
      status?: string;
      message?: string;
      is_market_open?: boolean;
    };
    if (body.status === 'error') {
      throw new MarketUnavailableError('twelvedata', body.message || 'Provider error');
    }
    const price = Number(body.close ?? body.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new MarketUnavailableError('twelvedata', 'Provider returned no usable price');
    }
    return {
      symbol,
      price,
      currency: CURRENCY_BY_SYMBOL[symbol] ?? 'USD',
      provider: 'twelvedata',
      providerTimestamp: body.datetime ? `${body.datetime}Z` : null,
      fetchedAt: new Date().toISOString(),
      quality: 'delayed',
      delayed: true,
      note:
        'Delayed market data from Twelve Data (free tier). Delay depends on plan and exchange; not a live execution feed.',
    };
  };

  const getQuote = async (symbol: string): Promise<Quote> => {
    const canonical = symbol.toUpperCase();
    const hit = cache.get(canonical);
    if (hit && Date.now() - hit.at < cfg.market.cacheTtlMs) {
      return { ...hit.quote, stale: false };
    }
    const provider = providerName();
    const fetcher = provider === 'twelvedata' ? fetchTwelveData : fetchGoldApi;
    try {
      const quote = await fetcher(canonical);
      cache.set(canonical, { quote, at: Date.now() });
      return quote;
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown provider failure';
      const stale = cache.get(canonical);
      if (stale) {
        return {
          ...stale.quote,
          stale: true,
          note: `${stale.quote.note} (provider unreachable: ${reason}; showing last cached value)`,
        };
      }
      throw new MarketUnavailableError(provider, reason);
    }
  };

  return { name: providerName(), getQuote, lastCached };
}
