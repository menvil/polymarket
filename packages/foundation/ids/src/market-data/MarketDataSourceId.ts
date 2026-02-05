import type { VenueId } from '../core/VenueId.js';
import { KnownVenues } from '../core/VenueId.js';

/**
 * MarketDataSourceId - источник маркет-данных
 *
 * @remarks
 * Отвечает на вопрос: "ОТКУДА мы ЧИТАЕМ данные?"
 *
 * Используется в:
 * - Quote (откуда котировка)
 * - Trade (откуда трейд)
 * - OrderBook (откуда стакан)
 *
 * Разделение Live vs Replay:
 * - Live sources: WebSocket, REST API (реал-тайм)
 * - Replay sources: Historical data (backtest)
 *
 * @example
 * ```typescript
 * // Live trading
 * const quote = {
 *   sourceId: 'POLYMARKET_WS' as MarketDataSourceId,
 *   bid: 0.48,
 *   ask: 0.52
 * };
 *
 * // Backtest
 * const historicalQuote = {
 *   sourceId: 'POLYMARKET_REPLAY' as MarketDataSourceId,
 *   bid: 0.48,
 *   ask: 0.52
 * };
 * ```
 */
export type MarketDataSourceId =
  | 'POLYMARKET_WS'
  | 'POLYMARKET_REST'
  | 'POLYMARKET_REPLAY'
  | 'KALSHI_WS'
  | 'KALSHI_REST'
  | 'KALSHI_REPLAY'
  | 'POLYGON_RPC'
  | (string & { readonly __brand: 'MarketDataSourceId' });

/**
 * Известные market data sources
 */
export const KnownMarketDataSources = {
  // Polymarket
  POLYMARKET_WS: 'POLYMARKET_WS' as MarketDataSourceId,
  POLYMARKET_REST: 'POLYMARKET_REST' as MarketDataSourceId,
  POLYMARKET_REPLAY: 'POLYMARKET_REPLAY' as MarketDataSourceId,

  // Kalshi
  KALSHI_WS: 'KALSHI_WS' as MarketDataSourceId,
  KALSHI_REST: 'KALSHI_REST' as MarketDataSourceId,
  KALSHI_REPLAY: 'KALSHI_REPLAY' as MarketDataSourceId,

  // On-chain
  POLYGON_RPC: 'POLYGON_RPC' as MarketDataSourceId,
} as const;

/**
 * Mapping: MarketDataSourceId → VenueId
 *
 * @remarks
 * Определяет к какому venue относится source данных.
 *
 * @example
 * ```typescript
 * sourceToVenue('POLYMARKET_WS')      // → 'POLYMARKET'
 * sourceToVenue('POLYMARKET_REPLAY')  // → 'POLYMARKET'
 * sourceToVenue('KALSHI_WS')          // → 'KALSHI'
 * ```
 */
export function sourceToVenue(sourceId: MarketDataSourceId): VenueId | undefined {
  const sourceStr = sourceId as string;

  if (sourceStr.startsWith('POLYMARKET')) {
    return KnownVenues.POLYMARKET;
  }

  if (sourceStr.startsWith('KALSHI')) {
    return KnownVenues.KALSHI;
  }

  return undefined;
}

/**
 * Проверка что source является live (не replay)
 */
export function isLiveSource(sourceId: MarketDataSourceId): boolean {
  const sourceStr = sourceId as string;
  return !sourceStr.includes('REPLAY');
}

/**
 * Проверка что source является replay (backtest)
 */
export function isReplaySource(sourceId: MarketDataSourceId): boolean {
  return !isLiveSource(sourceId);
}
