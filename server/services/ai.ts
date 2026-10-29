import type { AppConfig } from '../config';
import type { Quote } from './market';

export type AiErrorCode =
  | 'AI_NOT_CONFIGURED'
  | 'AI_TIMEOUT'
  | 'AI_PROVIDER_ERROR'
  | 'AI_INVALID_RESPONSE';

export class AiError extends Error {
  code: AiErrorCode;
  status: number;
  constructor(code: AiErrorCode, message: string, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface VisionRequest {
  imageDataUrl: string;
  instrument: string;
  timeframe: string;
  liveQuote: Quote | null;
}

export interface AiClient {
  readonly configured: boolean;
  readonly model: string;
  analyzeChart(req: VisionRequest): Promise<{ parsed: unknown; model: string }>;
}

export const SYSTEM_PROMPT = `You are a disciplined technical-analysis assistant for an Arabic trading platform.
You receive a SCREENSHOT of a trading chart (MT4/MT5/TradingView) and must return ONE JSON object only.

Hard rules:
- Use ONLY evidence visible in the screenshot. Never invent price levels, indicators, or market data.
- You have NO live market access. Any price you output must be readable from the chart image.
- If the chart is blurry, cropped, unreadable, has no visible price axis, or is not a trading chart, set "readable": false and "decision": "NO_TRADE" and explain why in "unreadable_reason".
- Never state or imply certainty, guaranteed profit, or win-rate percentages. "confidence" must be one of "low" | "medium" | "high" ONLY (a qualitative judgement, never a number).
- If no valid setup exists, use "decision": "NO_TRADE" and leave entry/stop_loss/take_profit_* as null. Do not fabricate a setup.
- For BUY: stop_loss < entry < take_profits. For SELL: take_profits < entry < stop_loss.
- All numbers must be plain numbers with "." decimals and no currency symbols, commas or spaces.
- Write all human-readable text in the language of the user's chart context if evident, otherwise English.

Return this exact JSON shape:
{
  "readable": boolean,
  "unreadable_reason": string | null,
  "detected_symbol": string | null,
  "chart_last_price": number | null,
  "market_context": string,
  "bias": "bullish" | "bearish" | "neutral",
  "decision": "BUY" | "SELL" | "CONDITIONAL_BUY" | "CONDITIONAL_SELL" | "NO_TRADE",
  "setup_type": string | null,
  "entry_type": "market" | "zone" | null,
  "entry": number | null,
  "entry_zone_low": number | null,
  "entry_zone_high": number | null,
  "stop_loss": number | null,
  "take_profit_1": number | null,
  "take_profit_2": number | null,
  "take_profit_3": number | null,
  "support_levels": number[],
  "resistance_levels": number[],
  "reasons": string[],
  "invalidation": string[],
  "warnings": string[],
  "confidence": "low" | "medium" | "high"
}`;

function buildUserPrompt(req: VisionRequest): string {
  const live = req.liveQuote
    ? `External reference price for ${req.instrument} at generation time: ${req.liveQuote.price} (provider ${req.liveQuote.provider}, quoted ${req.liveQuote.providerTimestamp || req.liveQuote.fetchedAt}, quality: ${req.liveQuote.quality}, delayed: true). Use it ONLY to sanity-check your reading of the chart's price axis, and never copy it as an entry price.`
    : 'No external market price is available for this instrument. Rely only on the chart screenshot.';
  return `Instrument selected by the customer: ${req.instrument}
Timeframe selected by the customer: ${req.timeframe}
${live}

Analyse the attached chart screenshot and return the JSON object described in the system prompt.`;
}

type FetchLike = typeof fetch;

export function createAiClient(cfg: AppConfig, fetchImpl: FetchLike = fetch): AiClient {
  const configured = Boolean(cfg.ai.apiKey);

  const request = async (
    body: Record<string, unknown>,
  ): Promise<{ parsed: unknown; model: string }> => {
    if (!cfg.ai.apiKey) {
      throw new AiError(
        'AI_NOT_CONFIGURED',
        'The AI vision provider is not configured on the server. Set AI_API_KEY (and optionally AI_BASE_URL / AI_MODEL) in the deployment environment.',
        503,
      );
    }
    const url = `${cfg.ai.baseUrl}/chat/completions`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.ai.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.ai.timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'network error';
      if (/timeout|aborted/i.test(msg)) {
        throw new AiError('AI_TIMEOUT', 'The AI provider did not answer in time. Please retry.', 504);
      }
      throw new AiError('AI_PROVIDER_ERROR', `Could not reach the AI provider: ${msg}`, 502);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const detail = text.slice(0, 400);
      if (res.status === 401 || res.status === 403) {
        throw new AiError(
          'AI_NOT_CONFIGURED',
          'The AI provider rejected the server API key. Check AI_API_KEY in the deployment environment.',
          503,
        );
      }
      throw new AiError(
        'AI_PROVIDER_ERROR',
        `AI provider error (HTTP ${res.status}). ${detail}`,
        502,
      );
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      model?: string;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new AiError('AI_INVALID_RESPONSE', 'The AI provider returned an empty response.', 502);
    }
    const parsed = extractJson(content);
    if (parsed === null) {
      throw new AiError(
        'AI_INVALID_RESPONSE',
        'The AI provider returned a response that was not valid JSON.',
        502,
      );
    }
    return { parsed, model: json.model || cfg.ai.model };
  };

  const analyzeChart = async (req: VisionRequest) => {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildUserPrompt(req) },
          { type: 'image_url', image_url: { url: req.imageDataUrl, detail: 'high' } },
        ],
      },
    ];
    const base: Record<string, unknown> = {
      model: cfg.ai.model,
      temperature: 0.1,
      max_tokens: 1600,
      messages,
    };
    const attempts: Record<string, unknown>[] = [];
    if (cfg.ai.structuredMode === 'json_schema') {
      attempts.push({
        ...base,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'chart_analysis', strict: false, schema: { type: 'object' } },
        },
      });
    }
    if (cfg.ai.structuredMode !== 'prompt') {
      attempts.push({ ...base, response_format: { type: 'json_object' } });
    }
    attempts.push(base);

    let lastErr: unknown = null;
    for (const body of attempts) {
      try {
        return await request(body);
      } catch (err) {
        lastErr = err;
        // Only retry when the provider rejected the response_format parameter.
        if (err instanceof AiError && err.code === 'AI_PROVIDER_ERROR' && /400/.test(err.message)) {
          continue;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new AiError('AI_PROVIDER_ERROR', 'AI request failed');
  };

  return { configured, model: cfg.ai.model, analyzeChart };
}

export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try next */
    }
  }
  return null;
}
