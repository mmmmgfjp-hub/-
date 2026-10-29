import { z } from 'zod';
import type { Quote } from './market';

export const INSTRUMENTS = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'NAS100', 'BTCUSD'] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

export const TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const INSTRUMENT_LABELS: Record<Instrument, string> = {
  XAUUSD: 'XAUUSD — Gold',
  EURUSD: 'EURUSD',
  GBPUSD: 'GBPUSD',
  USDJPY: 'USDJPY',
  NAS100: 'NAS100 / US100',
  BTCUSD: 'BTCUSD',
};

const PRICE_MIN = 0.00001;
const PRICE_MAX = 10_000_000;

const looseNumber = z.preprocess((value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9.\-]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}, z.number().nullable());

const looseNumberArray = z.preprocess((value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => {
      if (typeof v === 'number') return v;
      if (typeof v === 'string') return Number(v.replace(/[^0-9.\-]/g, ''));
      return NaN;
    })
    .filter((n) => Number.isFinite(n));
}, z.array(z.number()).max(12));

const stringArray = z.preprocess((value) => {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, 12);
}, z.array(z.string()));

const ModelSchema = z.object({
  readable: z.union([z.boolean(), z.string(), z.number()]).optional(),
  unreadable_reason: z.union([z.string(), z.null()]).optional(),
  detected_symbol: z.union([z.string(), z.null()]).optional(),
  chart_last_price: looseNumber.optional(),
  market_context: z.union([z.string(), z.null()]).optional(),
  bias: z.union([z.string(), z.null()]).optional(),
  decision: z.union([z.string(), z.null()]).optional(),
  setup_type: z.union([z.string(), z.null()]).optional(),
  entry_type: z.union([z.string(), z.null()]).optional(),
  entry: looseNumber.optional(),
  entry_zone_low: looseNumber.optional(),
  entry_zone_high: looseNumber.optional(),
  stop_loss: looseNumber.optional(),
  take_profit_1: looseNumber.optional(),
  take_profit_2: looseNumber.optional(),
  take_profit_3: looseNumber.optional(),
  support_levels: looseNumberArray.optional(),
  resistance_levels: looseNumberArray.optional(),
  reasons: stringArray.optional(),
  invalidation: stringArray.optional(),
  warnings: stringArray.optional(),
  confidence: z.union([z.string(), z.null()]).optional(),
});

export type Bias = 'bullish' | 'bearish' | 'neutral';
export type Decision = 'BUY' | 'SELL' | 'CONDITIONAL_BUY' | 'CONDITIONAL_SELL' | 'NO_TRADE';
export type Confidence = 'low' | 'medium' | 'high';

export interface Target {
  label: 'TP1' | 'TP2' | 'TP3';
  price: number;
  riskReward: number | null;
}

export interface AnalysisResult {
  instrument: Instrument;
  timeframe: Timeframe;
  generatedAt: string;
  readable: boolean;
  unreadableReason: string | null;
  detectedSymbol: string | null;
  chartLastPrice: number | null;
  marketContext: string;
  bias: Bias;
  decision: Decision;
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
  confidence: Confidence | null;
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

export interface SanitizeInput {
  raw: unknown;
  instrument: Instrument;
  timeframe: Timeframe;
  liveQuote: Quote | null;
  model: string;
  now?: Date;
}

const isPrice = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > PRICE_MIN && n < PRICE_MAX;

const validBias = (value: string | null | undefined): Bias => {
  const v = (value || '').toLowerCase();
  if (v.includes('bull')) return 'bullish';
  if (v.includes('bear')) return 'bearish';
  return 'neutral';
};

const validDecision = (value: string | null | undefined): Decision => {
  const v = (value || '').toUpperCase().replace(/[\s-]+/g, '_');
  if (v === 'BUY') return 'BUY';
  if (v === 'SELL') return 'SELL';
  if (v === 'CONDITIONAL_BUY' || v === 'BUY_LIMIT' || v === 'BUY_STOP') return 'CONDITIONAL_BUY';
  if (v === 'CONDITIONAL_SELL' || v === 'SELL_LIMIT' || v === 'SELL_STOP') return 'CONDITIONAL_SELL';
  return 'NO_TRADE';
};

const validConfidence = (value: string | null | undefined): Confidence | null => {
  const v = (value || '').toLowerCase();
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return null;
};

function dedupeLevels(levels: number[]): number[] {
  const valid = levels.filter((n) => isPrice(n)).sort((a, b) => a - b);
  const out: number[] = [];
  for (const n of valid) {
    if (!out.some((existing) => Math.abs(existing - n) / n < 0.0005)) out.push(n);
  }
  return out.slice(0, 6);
}

/**
 * Validates and sanitizes the model output. The server — not the model — computes
 * risk/reward, enforces trade geometry, and downgrades to NO_TRADE when the evidence
 * is incomplete or contradictory. No numeric field is ever invented here.
 */
export function sanitizeAnalysis(input: SanitizeInput): AnalysisResult {
  const parsed = ModelSchema.safeParse(input.raw);
  const notes: string[] = [];
  const nowIso = (input.now ?? new Date()).toISOString();

  if (!parsed.success) {
    return {
      instrument: input.instrument,
      timeframe: input.timeframe,
      generatedAt: nowIso,
      readable: false,
      unreadableReason: 'The AI response could not be validated as a structured analysis.',
      detectedSymbol: null,
      chartLastPrice: null,
      marketContext: '',
      bias: 'neutral',
      decision: 'NO_TRADE',
      setupType: null,
      entryType: null,
      entry: null,
      entryZone: null,
      stopLoss: null,
      targets: [],
      supportLevels: [],
      resistanceLevels: [],
      reasons: [],
      invalidation: [],
      warnings: ['No validated analysis was produced.'],
      confidence: null,
      riskRewardNote: null,
      livePrice: null,
      priceConflict: null,
      sanitizationNotes: ['Structured output failed schema validation; nothing was displayed.'],
      dataSources: ['chart screenshot'],
      model: input.model,
    };
  }

  const m = parsed.data;
  const readable =
    m.readable === true || m.readable === 'true' || m.readable === 1 || m.readable === undefined;

  let decision = readable ? validDecision(m.decision) : 'NO_TRADE';
  const bias = validBias(m.bias);
  let stopLoss = isPrice(m.stop_loss) ? m.stop_loss : null;
  let entry = isPrice(m.entry) ? m.entry : null;
  let entryZone: { low: number; high: number } | null = null;

  if (isPrice(m.entry_zone_low) && isPrice(m.entry_zone_high)) {
    const low = Math.min(m.entry_zone_low, m.entry_zone_high);
    const high = Math.max(m.entry_zone_low, m.entry_zone_high);
    if (high > low) {
      entryZone = { low, high };
      if (entry === null) entry = (low + high) / 2;
    }
  }

  const chartLastPrice = isPrice(m.chart_last_price) ? m.chart_last_price : null;

  const direction = decision === 'BUY' || decision === 'CONDITIONAL_BUY'
    ? 'long'
    : decision === 'SELL' || decision === 'CONDITIONAL_SELL'
      ? 'short'
      : null;

  // Enforce trade geometry. Never repair numbers by guessing: drop them instead.
  if (direction && entry !== null) {
    if (stopLoss !== null) {
      const validStop = direction === 'long' ? stopLoss < entry : stopLoss > entry;
      if (!validStop) {
        notes.push(
          direction === 'long'
            ? 'Stop loss was not below the entry on a long setup and was discarded.'
            : 'Stop loss was not above the entry on a short setup and was discarded.',
        );
        stopLoss = null;
      }
    }

    // Reject setups whose levels are wildly inconsistent with the visible chart price.
    if (chartLastPrice !== null && entry !== null) {
      const deviation = Math.abs(entry - chartLastPrice) / chartLastPrice;
      if (deviation > 0.15) {
        notes.push(
          'The proposed entry was more than 15% away from the price visible on the chart and was discarded.',
        );
        decision = 'NO_TRADE';
        entry = null;
        stopLoss = null;
        entryZone = null;
      }
    }
  }

  const rawTargets: { label: 'TP1' | 'TP2' | 'TP3'; price: number }[] = [];
  for (const [label, price] of [
    ['TP1', m.take_profit_1],
    ['TP2', m.take_profit_2],
    ['TP3', m.take_profit_3],
  ] as const) {
    if (isPrice(price)) rawTargets.push({ label, price: price as number });
  }

  const risk = entry !== null && stopLoss !== null ? Math.abs(entry - stopLoss) : null;
  const targets: Target[] = [];
  if (direction && entry !== null && risk !== null && risk > 0) {
    for (const t of rawTargets) {
      const correctSide = direction === 'long' ? t.price > entry : t.price < entry;
      if (!correctSide) {
        notes.push(`${t.label} was on the wrong side of the entry for this setup and was discarded.`);
        continue;
      }
      const reward = Math.abs(t.price - entry);
      targets.push({
        label: t.label,
        price: t.price,
        riskReward: Math.round((reward / risk) * 100) / 100,
      });
    }
  }

  const effectiveDecision: Decision =
    direction && entry !== null && (stopLoss !== null || entryZone !== null) && targets.length > 0
      ? decision
      : readable
        ? 'NO_TRADE'
        : 'NO_TRADE';

  if (readable && direction && effectiveDecision === 'NO_TRADE') {
    notes.push(
      'A directional idea was returned without a complete, consistent entry / stop / target structure, so it is presented as NO TRADE.',
    );
  }

  const finalStop = effectiveDecision === 'NO_TRADE' ? (stopLoss && entry && targets.length ? stopLoss : null) : stopLoss;
  const finalEntry = effectiveDecision === 'NO_TRADE' ? (targets.length && stopLoss ? entry : null) : entry;
  const finalTargets = effectiveDecision === 'NO_TRADE' && !(finalEntry && finalStop) ? [] : targets;

  const warnings = (m.warnings ?? []).slice(0, 8);
  const liveQuote = input.liveQuote;

  let priceConflict: AnalysisResult['priceConflict'] = null;
  if (chartLastPrice !== null && liveQuote) {
    const diffPct =
      Math.round((Math.abs(chartLastPrice - liveQuote.price) / liveQuote.price) * 10000) / 100;
    const threshold = 0.3;
    priceConflict = {
      detected: diffPct > threshold,
      differencePct: diffPct,
      description:
        diffPct > threshold
          ? 'The last price visible on the screenshot differs from the current provider quote by ' +
            `${diffPct}%. The screenshot is likely older than the live feed; levels are derived from the screenshot only.`
          : `The chart price is within ${diffPct}% of the current provider quote.`,
    };
  }

  const riskRewardNote =
    finalTargets.length > 0 && finalEntry !== null && finalStop !== null
      ? `Risk/reward is computed by the server from entry ${finalEntry}, stop ${finalStop}: ` +
        finalTargets.map((t) => `${t.label} = 1:${t.riskReward}`).join(', ') +
        '. These are chart-derived levels, not guaranteed outcomes, and a stop may fill at a worse price during gaps or slippage.'
      : null;

  return {
    instrument: input.instrument,
    timeframe: input.timeframe,
    generatedAt: nowIso,
    readable,
    unreadableReason: readable ? null : (m.unreadable_reason ?? 'The screenshot was not readable.'),
    detectedSymbol: m.detected_symbol ?? null,
    chartLastPrice,
    marketContext: m.market_context ?? '',
    bias,
    decision: effectiveDecision,
    setupType: m.setup_type ?? null,
    entryType:
      m.entry_type === 'zone' ? 'zone' : m.entry_type === 'market' ? 'market' : entryZone ? 'zone' : null,
    entry: finalEntry,
    entryZone: finalEntry !== null ? entryZone : null,
    stopLoss: finalStop,
    targets: finalTargets,
    supportLevels: dedupeLevels(m.support_levels ?? []),
    resistanceLevels: dedupeLevels(m.resistance_levels ?? []),
    reasons: (m.reasons ?? []).slice(0, 10),
    invalidation: (m.invalidation ?? []).slice(0, 8),
    warnings,
    confidence: validConfidence(m.confidence),
    riskRewardNote,
    livePrice: liveQuote
      ? {
          price: liveQuote.price,
          provider: liveQuote.provider,
          providerTimestamp: liveQuote.providerTimestamp,
          fetchedAt: liveQuote.fetchedAt,
          quality: liveQuote.quality,
          delayed: liveQuote.delayed,
          note: liveQuote.note,
        }
      : null,
    priceConflict,
    sanitizationNotes: notes,
    dataSources: liveQuote
      ? ['chart screenshot (prices read by AI)', `${liveQuote.provider} (reference quote)`]
      : ['chart screenshot (prices read by AI)'],
    model: input.model,
  };
}

export function isSuccessfulAnalysis(result: AnalysisResult): boolean {
  return result.readable;
}
