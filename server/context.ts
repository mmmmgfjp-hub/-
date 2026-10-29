import type { AppConfig } from './config';
import type { DB } from './db';
import type { AiClient } from './services/ai';
import type { MarketService } from './services/market';
import type { Mailer } from './services/email';
import type { buildRateLimiters } from './http';

export interface RouteContext {
  db: DB;
  cfg: AppConfig;
  ai: AiClient;
  market: MarketService;
  mailer: Mailer;
  secret: string;
  log: (level: string, event: string, meta?: unknown) => void;
  limiters: ReturnType<typeof buildRateLimiters>;
  now: () => Date;
}
