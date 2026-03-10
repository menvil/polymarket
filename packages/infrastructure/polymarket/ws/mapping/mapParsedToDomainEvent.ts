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

import type { PolymarketMessage } from '../PolymarketMessageRouter.js';
import { OrderBookSnapshotReceivedEvent } from '../../events/OrderBookSnapshotReceivedEvent.js';
import { TradeExecutedEvent } from '../../events/TradeExecutedEvent.js';
import type { TradeSide } from '../../events/TradeExecutedEvent.js';
import type { DomainEvent } from '../../events/DomainEvent.js';

/**
 * Маппит Polymarket WS сообщение в DomainEvent
 *
 * @param message - Распарсенное сообщение Polymarket (от Router)
 * @returns DomainEvent если валидное data сообщение, null иначе
 *
 * @remarks
 * Чистая функция - никогда не бросает исключения, возвращает null для невалидных данных.
 *
 * Правила маппинга:
 * - event_type === 'book' → OrderBookSnapshotReceivedEvent
 * - event_type === 'trade' | 'last_trade_price' → TradeExecutedEvent
 * - Контрольные сообщения (pong, subscribed, error, и т.д.) → null
 * - Невалидные данные (отсутствует asset_id, NaN цены, и т.д.) → null
 *
 * @example
 * ```typescript
 * const event = mapParsedToDomainEvent(polymarketMessage);
 * if (event) {
 *   eventBus.publish(event);
 * }
 * ```
 */
export function mapParsedToDomainEvent(
  message: PolymarketMessage
): DomainEvent | null {
  const eventType = message.event_type;

  // Маппим orderbook сообщения
  if (eventType === 'book') {
    return mapOrderbookMessage(message as any);
  }

  // Маппим trade сообщения
  if (eventType === 'trade' || eventType === 'last_trade_price') {
    return mapTradeMessage(message as any);
  }

  // Контрольные сообщения → null
  // (pong, subscribed, unsubscribed, error, price_change, tick_size_change)
  return null;
}

/**
 * Маппит orderbook сообщение в OrderBookSnapshotReceivedEvent
 *
 * @param message - Orderbook сообщение
 * @returns Event или null если невалидно
 *
 * @remarks
 * Валидирует:
 * - asset_id является non-empty string
 * - bids/asks являются массивами
 * - Каждый уровень имеет валидные price и size (парсятся в number, не NaN)
 * - timestamp валиден (number → Date, string → Date, undefined → now)
 *
 * **ВАЖНО:** Polymarket возвращает orderbook в обратном порядке:
 * - bids: [0.01, 0.02, ..., 0.51] (худшие → лучшие)
 * - asks: [0.99, 0.98, ..., 0.52] (худшие → лучшие)
 *
 * Мы разворачиваем массивы чтобы соответствовать стандартной convention:
 * - bids[0] = лучший (самый высокий) bid
 * - asks[0] = лучший (самый низкий) ask
 */
function mapOrderbookMessage(message: any): OrderBookSnapshotReceivedEvent | null {
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
 * Маппит trade сообщение в TradeExecutedEvent
 *
 * @param message - Trade сообщение
 * @returns Event или null если невалидно
 *
 * @remarks
 * Валидирует:
 * - asset_id является non-empty string
 * - price парсится в number (не NaN)
 * - size парсится в number (не NaN)
 * - side является 'BUY' | 'SELL' | undefined (undefined → null в событии)
 * - timestamp валиден
 */
function mapTradeMessage(message: any): TradeExecutedEvent | null {
  // Валидируем asset_id
  const assetId = message.asset_id;
  if (typeof assetId !== 'string' || assetId.length === 0) {
    return null;
  }

  // Парсим price
  const price = parseFloat(message.price);
  if (isNaN(price)) {
    return null;
  }

  // Парсим size
  const size = parseFloat(message.size);
  if (isNaN(size)) {
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
 * Парсит массив уровней orderbook
 *
 * @param levels - Массив {price: string, size: string}
 * @returns Распарсенные уровни или null если какой-либо уровень невалиден
 *
 * @remarks
 * Возвращает null если любой уровень имеет NaN price или size.
 * Пустой массив валиден (нет ликвидности).
 */
function parseLevels(
  levels: any[]
): Array<{ price: number; size: number }> | null {
  const result: Array<{ price: number; size: number }> = [];

  for (const level of levels) {
    // Парсим price
    const price = parseFloat(level.price);
    if (isNaN(price)) {
      return null;
    }

    // Парсим size
    const size = parseFloat(level.size);
    if (isNaN(size)) {
      return null;
    }

    result.push({ price, size });
  }

  return result;
}

/**
 * Парсит сторону сделки
 *
 * @param side - Строка стороны из сообщения
 * @returns 'BUY' | 'SELL' | null
 *
 * @remarks
 * - 'BUY' → 'BUY'
 * - 'SELL' → 'SELL'
 * - undefined → null (валидно для last_trade_price)
 * - Любое другое значение → null
 */
function parseTradeSide(side: unknown): TradeSide {
  if (side === 'BUY') return 'BUY';
  if (side === 'SELL') return 'SELL';
  return null;
}

/**
 * Парсит timestamp в Date
 *
 * @param timestamp - Timestamp из сообщения (number | string | undefined)
 * @returns Date объект
 *
 * @remarks
 * - number → new Date(number)
 * - string → new Date(string)
 * - undefined → new Date() (текущее время)
 * - Невалидная дата → new Date() (fallback к текущему времени)
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
