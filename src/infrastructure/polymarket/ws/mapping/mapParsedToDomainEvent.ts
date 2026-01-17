/**
 * Чистый маппер: PolymarketMessage → DomainEvent | null
 *
 * @remarks
 * Чистая функция без side-effects для маппинга Polymarket WS messages в Domain Events.
 *
 * Принципы:
 * - Чистая функция (без side effects, без logger, без state)
 * - Никогда не бросает исключения (возвращает null для невалидных данных)
 * - Маппит только data события (book, trade, last_trade_price)
 * - Возвращает null для контрольных сообщений (pong, subscribed, error, и т.д.)
 * - Валидирует данные (возвращает null если невалидно)
 *
 * Валидация:
 * - asset_id должен быть non-empty string
 * - bids/asks должны быть массивами (могут быть пустыми)
 * - price/size должны парситься в валидные numbers (не NaN)
 * - timestamp: number → Date, string → Date, undefined → new Date()
 *
 * @example
 * ```typescript
 * // Orderbook сообщение
 * const bookMsg: PolymarketOrderbookMessage = {
 *   event_type: 'book',
 *   asset_id: 'token-123',
 *   bids: [{price: '0.52', size: '100'}],
 *   asks: [{price: '0.53', size: '150'}],
 *   timestamp: 1234567890
 * };
 * const event1 = mapParsedToDomainEvent(bookMsg);
 * // → OrderBookSnapshotReceivedEvent
 *
 * // Trade сообщение
 * const tradeMsg: PolymarketTradeMessage = {
 *   event_type: 'trade',
 *   asset_id: 'token-123',
 *   price: '0.52',
 *   size: '50',
 *   side: 'BUY'
 * };
 * const event2 = mapParsedToDomainEvent(tradeMsg);
 * // → TradeExecutedEvent
 *
 * // Контрольное сообщение
 * const pongMsg: PolymarketControlMessage = {
 *   event_type: 'pong'
 * };
 * const event3 = mapParsedToDomainEvent(pongMsg);
 * // → null
 * ```
 */

import type {
  PolymarketMessage,
  PolymarketOrderbookMessage,
  PolymarketTradeMessage,
} from '../PolymarketMessageRouter.js';
import { OrderBookSnapshotReceivedEvent } from '../../../../domain/events/OrderBookSnapshotReceivedEvent.js';
import { TradeExecutedEvent } from '../../../../domain/events/TradeExecutedEvent.js';
import type { TradeSide } from '../../../../domain/events/TradeExecutedEvent.js';
import type { DomainEvent } from '../../../../domain/events/DomainEvent.js';

/**
 * Map a parsed Polymarket WebSocket message into the corresponding domain event.
 *
 * @param message - The parsed Polymarket WS message to map.
 * @returns A DomainEvent for valid data messages; `null` for control or invalid messages.
 */
export function mapParsedToDomainEvent(
  message: PolymarketMessage
): DomainEvent | null {
  // Маппим orderbook сообщения
  if (message.event_type === 'book') {
    return mapOrderbookMessage(message);
  }

  // Маппим trade сообщения
  if (message.event_type === 'trade' || message.event_type === 'last_trade_price') {
    return mapTradeMessage(message);
  }

  // Контрольные сообщения → null
  // (pong, subscribed, unsubscribed, error, price_change, tick_size_change)
  return null;
}

/**
 * Map a Polymarket orderbook message to an OrderBookSnapshotReceivedEvent.
 *
 * Validates input and returns `null` for invalid or control messages. On success
 * returns an event with parsed numeric levels and a normalized orderbook where
 * best price levels appear first.
 *
 * @param message - Parsed Polymarket orderbook message
 * @returns The mapped OrderBookSnapshotReceivedEvent for valid input, `null` otherwise
 */
function mapOrderbookMessage(message: PolymarketOrderbookMessage): OrderBookSnapshotReceivedEvent | null {
  // Валидируем asset_id
  const assetId = message.asset_id;
  if (typeof assetId !== 'string' || assetId.length === 0) {
    return null;
  }

  // Валидируем что bids/asks являются массивами
  const rawBids = message.bids;
  const rawAsks = message.asks;
  if (!Array.isArray(rawBids) || !Array.isArray(rawAsks)) {
    return null;
  }

  // Парсим bids
  const bids = parseLevels(rawBids);
  if (bids === null) {
    return null;
  }

  // Парсим asks
  const asks = parseLevels(rawAsks);
  if (asks === null) {
    return null;
  }

  // ВАЖНО: Polymarket возвращает orderbook в обратном порядке!
  // bids: [0.01, 0.02, ..., 0.51] (худшие → лучшие)
  // asks: [0.99, 0.98, ..., 0.52] (худшие → лучшие)
  // Но наша модель ожидает стандартный порядок (лучшие первыми)
  // Поэтому разворачиваем массивы
  bids.reverse();
  asks.reverse();

  // Парсим timestamp
  const timestamp = parseTimestamp(message.timestamp);

  return new OrderBookSnapshotReceivedEvent(
    assetId,
    bids,
    asks,
    timestamp
  );
}

/**
 * Convert a Polymarket trade message into a domain trade event.
 *
 * Validates the input and returns a domain event only for well-formed trade messages.
 *
 * @param message - The parsed Polymarket trade message to map
 * @returns `TradeExecutedEvent` for a valid trade message, `null` otherwise
 *
 * @remarks
 * The function requires:
 * - `asset_id` to be a non-empty string
 * - `price` to parse to a number greater than or equal to 0
 * - `size` to parse to a number greater than 0
 * - `side` to be `'BUY' | 'SELL'` or `undefined` (treated as no side)
 * - `timestamp` to be convertible to a valid `Date` (falls back to current time if absent/invalid)
 */
function mapTradeMessage(message: PolymarketTradeMessage): TradeExecutedEvent | null {
  // Валидируем asset_id
  const assetId = message.asset_id;
  if (typeof assetId !== 'string' || assetId.length === 0) {
    return null;
  }

  // Парсим price
  const price = parseFloat(message.price);
  if (isNaN(price) || price < 0) {
    return null;
  }

  // Парсим size
  const size = parseFloat(message.size);
  if (isNaN(size) || size <= 0) {
    return null;
  }

  // Парсим side (может быть undefined для last_trade_price)
  const side = parseTradeSide(message.side);

  // Парсим timestamp
  const timestamp = parseTimestamp(message.timestamp);

  return new TradeExecutedEvent(
    assetId,
    price,
    size,
    side,
    timestamp
  );
}

/**
 * Validates and parses an array of orderbook level objects into numeric price/size pairs.
 *
 * @param levels - Array of objects expected to have string `price` and `size` properties.
 * @returns An array of `{ price: number; size: number }` for valid levels, or `null` if any level is missing required fields, contains non-numeric values, or has negative `price` or `size`. An empty input array yields an empty result array.
 */
function parseLevels(
  levels: any[]
): Array<{ price: number; size: number }> | null {
  const result: Array<{ price: number; size: number }> = [];

  for (const level of levels) {
    // Валидация структуры уровня
    if (level === null || typeof level !== 'object' || !('price' in level) || !('size' in level)) {
      return null;
    }

    // Парсим price
    const price = parseFloat(level.price);
    if (isNaN(price)) {
      return null;
    }
    if (price < 0) {
      return null;
    }

    // Парсим size
    const size = parseFloat(level.size);
    if (isNaN(size)) {
      return null;
    }
    if (size < 0) {
      return null;
    }

    result.push({ price, size });
  }

  return result;
}

/**
 * Convert an incoming side value to a canonical trade side.
 *
 * @param side - The raw side value from the message (may be any type)
 * @returns `'BUY'` if `side` equals `'BUY'`, `'SELL'` if `side` equals `'SELL'`, `null` otherwise
 */
function parseTradeSide(side: unknown): TradeSide {
  if (side === 'BUY') return 'BUY';
  if (side === 'SELL') return 'SELL';
  return null;
}

/**
 * Convert an input timestamp into a valid Date.
 *
 * Accepts a number (treated as milliseconds since epoch), a string (parsed as a date), or undefined.
 * If `timestamp` is undefined or cannot be parsed into a valid date, the current date/time is returned.
 *
 * @param timestamp - The incoming timestamp value to parse (number | string | undefined)
 * @returns A `Date` parsed from `timestamp`, or the current date/time if parsing fails or `timestamp` is undefined
 */
function parseTimestamp(timestamp: unknown): Date {
  // Если undefined, используем текущее время
  if (timestamp === undefined) {
    return new Date();
  }

  // Если number, создаём Date из миллисекунд
  if (typeof timestamp === 'number') {
    const date = new Date(timestamp);
    // Проверяем валидность даты
    if (isNaN(date.getTime())) {
      return new Date();
    }
    return date;
  }

  // Если string, пытаемся распарсить
  if (typeof timestamp === 'string') {
    const date = new Date(timestamp);
    // Проверяем валидность даты
    if (isNaN(date.getTime())) {
      return new Date();
    }
    return date;
  }

  // Fallback к текущему времени
  return new Date();
}