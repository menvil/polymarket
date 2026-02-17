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
 * Branded string для extensibility: можно добавлять новые sources
 * без изменения foundation layer.
 *
 * Известные sources:
 * - POLYMARKET_WS, POLYMARKET_REST: Polymarket live data
 * - POLYMARKET_REPLAY: Polymarket historical data (backtest)
 * - KALSHI_WS, KALSHI_REST: Kalshi live data
 * - KALSHI_REPLAY: Kalshi historical data (backtest)
 * - POLYGON_RPC: Polygon blockchain RPC
 *
 * @example
 * ```typescript
 * import { KnownMarketDataSources, asMarketDataSourceId } from '@polymarket/ids';
 *
 * // Live trading
 * const quote = {
 *   sourceId: KnownMarketDataSources.POLYMARKET_WS,
 *   bid: 0.48,
 *   ask: 0.52
 * };
 *
 * // Backtest
 * const historicalQuote = {
 *   sourceId: KnownMarketDataSources.POLYMARKET_REPLAY,
 *   bid: 0.48,
 *   ask: 0.52
 * };
 *
 * // Custom source с валидацией
 * const customSource = asMarketDataSourceId('MY_CUSTOM_SOURCE');
 * if (customSource) {
 *   console.log('Valid market data source');
 * }
 * ```
 */
export type MarketDataSourceId = string & { readonly __brand: 'MarketDataSourceId' };

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
 * Metadata для market data sources
 * @internal
 */
interface SourceMetadata {
  readonly venue: VenueId | undefined;
  readonly isLive: boolean;
  readonly type: 'ws' | 'rest' | 'replay' | 'rpc';
}

/**
 * Structured metadata для известных market data sources
 * @internal
 */
const SOURCE_META: Readonly<Record<keyof typeof KnownMarketDataSources, SourceMetadata>> = {
  // Polymarket
  POLYMARKET_WS: {
    venue: KnownVenues.POLYMARKET,
    isLive: true,
    type: 'ws',
  },
  POLYMARKET_REST: {
    venue: KnownVenues.POLYMARKET,
    isLive: true,
    type: 'rest',
  },
  POLYMARKET_REPLAY: {
    venue: KnownVenues.POLYMARKET,
    isLive: false,
    type: 'replay',
  },

  // Kalshi
  KALSHI_WS: {
    venue: KnownVenues.KALSHI,
    isLive: true,
    type: 'ws',
  },
  KALSHI_REST: {
    venue: KnownVenues.KALSHI,
    isLive: true,
    type: 'rest',
  },
  KALSHI_REPLAY: {
    venue: KnownVenues.KALSHI,
    isLive: false,
    type: 'replay',
  },

  // On-chain
  POLYGON_RPC: {
    venue: undefined, // RPC не привязан к конкретному venue
    isLive: true,
    type: 'rpc',
  },
} as const;

/**
 * Set известных market data sources для быстрой проверки
 * @internal
 */
const KNOWN_SOURCE_SET = new Set<string>(Object.values(KnownMarketDataSources));

/**
 * Type guard для проверки известных market data sources
 *
 * @param id - Строка для проверки
 * @returns true если id является известным market data source
 *
 * @remarks
 * Проверяет только известные sources (POLYMARKET_WS, KALSHI_REPLAY, etc).
 * Для проверки формата custom sources используй asMarketDataSourceId().
 *
 * @example
 * ```typescript
 * isKnownMarketDataSource('POLYMARKET_WS'); // → true
 * isKnownMarketDataSource('KALSHI_REPLAY'); // → true
 * isKnownMarketDataSource('CUSTOM_SOURCE'); // → false (неизвестный source)
 * ```
 */
export function isKnownMarketDataSource(id: string): id is MarketDataSourceId {
  return KNOWN_SOURCE_SET.has(id);
}

/**
 * Валидация и парсинг MarketDataSourceId
 *
 * @param raw - Строка для парсинга
 * @returns MarketDataSourceId или undefined если формат невалидный
 *
 * @remarks
 * Валидирует формат MarketDataSourceId:
 * - Только uppercase буквы, цифры, подчеркивания
 * - Длина 1-64 символа (больше чем другие ID для составных имен типа POLYMARKET_WS)
 * - Не может начинаться с цифры
 * - НЕ содержит ':' или '\' (гарантия для round-trip сериализации)
 *
 * Поддерживает как известные sources (POLYMARKET_WS, KALSHI_REPLAY),
 * так и кастомные sources с валидным форматом.
 *
 * Для строгой проверки только известных sources используй isKnownMarketDataSource().
 *
 * @example
 * ```typescript
 * asMarketDataSourceId('POLYMARKET_WS'); // → 'POLYMARKET_WS' as MarketDataSourceId
 * asMarketDataSourceId('KALSHI_REPLAY'); // → 'KALSHI_REPLAY' as MarketDataSourceId
 * asMarketDataSourceId('MY_CUSTOM_SOURCE'); // → 'MY_CUSTOM_SOURCE' as MarketDataSourceId
 * asMarketDataSourceId('invalid-source'); // → undefined (содержит дефис)
 * asMarketDataSourceId('123SOURCE'); // → undefined (начинается с цифры)
 * asMarketDataSourceId(''); // → undefined (пустая строка)
 * asMarketDataSourceId('has:colon'); // → undefined (содержит ':')
 * ```
 */
export function asMarketDataSourceId(raw: string): MarketDataSourceId | undefined {
  // Формат: uppercase буквы, цифры, подчеркивания, 1-64 символа, не начинается с цифры
  // Regex автоматически запрещает ':' и '\' (не входят в [A-Z0-9_])
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(raw)) {
    return undefined;
  }

  return raw as MarketDataSourceId;
}

/**
 * Mapping: MarketDataSourceId → VenueId
 *
 * @param sourceId - MarketDataSourceId
 * @returns VenueId или undefined если source не привязан к venue или неизвестен
 *
 * @remarks
 * Определяет к какому venue относится source данных.
 *
 * **Только для известных sources из SOURCE_META.**
 * Для unknown sources возвращает `undefined` (не угадывает).
 *
 * Если нужна поддержка custom sources, добавь их в SOURCE_META через
 * регистрацию или расширение KnownMarketDataSources.
 *
 * @example
 * ```typescript
 * sourceToVenue(KnownMarketDataSources.POLYMARKET_WS);      // → 'POLYMARKET' as VenueId
 * sourceToVenue(KnownMarketDataSources.POLYMARKET_REPLAY);  // → 'POLYMARKET' as VenueId
 * sourceToVenue(KnownMarketDataSources.KALSHI_WS);          // → 'KALSHI' as VenueId
 * sourceToVenue(KnownMarketDataSources.POLYGON_RPC);        // → undefined (RPC не привязан к venue)
 *
 * // Unknown source
 * const unknownSource = asMarketDataSourceId('MY_CUSTOM_SOURCE')!;
 * sourceToVenue(unknownSource); // → undefined (unknown, не угадываем)
 * ```
 */
export function sourceToVenue(sourceId: MarketDataSourceId): VenueId | undefined {
  // Только для известных sources из SOURCE_META
  // Приводим к Record<string, ...> для безопасного обращения с custom/unknown sources
  const metadata = (SOURCE_META as Record<string, SourceMetadata | undefined>)[sourceId];
  return metadata?.venue;
}

/**
 * Проверка что source является live (не replay)
 *
 * @param sourceId - MarketDataSourceId для проверки
 * @returns true если live, false если replay, undefined если unknown source
 *
 * @remarks
 * **Только для известных sources из SOURCE_META.**
 * Для unknown sources возвращает `undefined` (не угадывает).
 *
 * Live sources:
 * - WebSocket (POLYMARKET_WS, KALSHI_WS)
 * - REST API (POLYMARKET_REST, KALSHI_REST)
 * - RPC (POLYGON_RPC)
 *
 * Replay sources:
 * - Historical data (POLYMARKET_REPLAY, KALSHI_REPLAY)
 *
 * @example
 * ```typescript
 * isLiveSource(KnownMarketDataSources.POLYMARKET_WS);     // → true
 * isLiveSource(KnownMarketDataSources.POLYMARKET_REST);   // → true
 * isLiveSource(KnownMarketDataSources.POLYMARKET_REPLAY); // → false
 * isLiveSource(KnownMarketDataSources.POLYGON_RPC);       // → true
 *
 * // Unknown source
 * const unknownSource = asMarketDataSourceId('MY_CUSTOM_SOURCE')!;
 * isLiveSource(unknownSource); // → undefined (unknown, не угадываем)
 * ```
 */
export function isLiveSource(sourceId: MarketDataSourceId): boolean | undefined {
  // Только для известных sources из SOURCE_META
  // Приводим к Record<string, ...> для безопасного обращения с custom/unknown sources
  const metadata = (SOURCE_META as Record<string, SourceMetadata | undefined>)[sourceId];
  return metadata?.isLive;
}

/**
 * Проверка что source является replay (backtest)
 *
 * @param sourceId - MarketDataSourceId для проверки
 * @returns true если replay, false если live, undefined если unknown source
 *
 * @remarks
 * Inverse функция от isLiveSource().
 * Используется для backtest и исторического анализа.
 *
 * @example
 * ```typescript
 * isReplaySource(KnownMarketDataSources.POLYMARKET_REPLAY); // → true
 * isReplaySource(KnownMarketDataSources.KALSHI_REPLAY);     // → true
 * isReplaySource(KnownMarketDataSources.POLYMARKET_WS);     // → false
 * isReplaySource(KnownMarketDataSources.POLYGON_RPC);       // → false
 *
 * // Unknown source
 * const unknownSource = asMarketDataSourceId('MY_CUSTOM_SOURCE')!;
 * isReplaySource(unknownSource); // → undefined (unknown)
 * ```
 */
export function isReplaySource(sourceId: MarketDataSourceId): boolean | undefined {
  const isLive = isLiveSource(sourceId);
  if (isLive === undefined) {
    return undefined;
  }
  return !isLive;
}
