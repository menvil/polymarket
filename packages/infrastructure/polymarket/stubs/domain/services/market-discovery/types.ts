/**
 * Stub типов для market-discovery сервиса.
 *
 * @remarks
 * INTERNAL STUB — используется PolymarketMarketDataRestClient до реализации Phase 1 domain services.
 */

/** Данные рынка из Gamma API */
export interface GammaMarketData {
  conditionId: string;
  question: string;
  slug?: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  enableOrderBook: boolean;
  /** JSON-строка: "[\"token1\", \"token2\"]" */
  clobTokenIds: string;
  /** JSON-строка: "[\"Yes\", \"No\"]" */
  outcomes: string;
  liquidity?: string;
  spread?: number;
  bestBid?: number;
  bestAsk?: number;
  orderMinSize?: number;
  orderPriceMinTickSize?: number;
  description?: string;
  tags?: string[];
}
