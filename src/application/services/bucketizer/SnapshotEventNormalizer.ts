/**
 * Snapshot Event Normalizer
 *
 * @remarks
 * Преобразует сырые JSONL строки из snapshot файлов в DomainEvent объекты.
 *
 * Алгоритм:
 * 1. Парсит JSON string в RawWsEvent
 * 2. Валидирует структуру
 * 3. Использует mapParsedToDomainEvent для преобразования в domain события
 * 4. Возвращает null для невалидных данных (без исключений)
 *
 * Особенности:
 * - Чистая функция (без side-effects)
 * - Никогда не бросает исключения (возвращает null)
 * - Обрабатывает data события (book, trade, last_trade_price)
 * - Игнорирует контрольные сообщения (pong, subscribed, error)
 *
 * @example
 * ```typescript
 * const line = '{"event_type":"book","asset_id":"0x123","bids":[],"asks":[]}';
 *
 * const event = normalizeSnapshotEvent(line);
 * if (event) {
 *   // event is OrderBookSnapshotReceivedEvent
 *   console.log('Normalized event:', event.constructor.name);
 * }
 * ```
 *
 * @module application/services/bucketizer
 */

import { mapParsedToDomainEvent } from '../../../infrastructure/polymarket/ws/mapping/mapParsedToDomainEvent.js';
import type { DomainEvent } from '../../../domain/events/DomainEvent.js';

/**
 * Нормализует сырую JSONL строку в DomainEvent
 *
 * @param line - JSONL строка из snapshot файла
 * @returns DomainEvent если валидно, null иначе
 *
 * @throws Никогда - возвращает null для невалидных данных
 *
 * @remarks
 * Алгоритм:
 * 1. Парсит JSON
 * 2. Проверяет наличие event_type
 * 3. Использует mapParsedToDomainEvent для преобразования
 * 4. Возвращает результат (может быть null)
 *
 * Возвращает null если:
 * - JSON parse error
 * - Отсутствует event_type
 * - mapParsedToDomainEvent вернул null (контрольное сообщение или невалидные данные)
 *
 * @example
 * ```typescript
 * // Book событие
 * const bookLine = '{"event_type":"book","asset_id":"0x123","bids":[],"asks":[]}';
 * const bookEvent = normalizeSnapshotEvent(bookLine);
 * // → OrderBookSnapshotReceivedEvent
 *
 * // Trade событие
 * const tradeLine = '{"event_type":"trade","asset_id":"0x123","price":"0.5","size":"100","side":"BUY"}';
 * const tradeEvent = normalizeSnapshotEvent(tradeLine);
 * // → TradeExecutedEvent
 *
 * // Невалидный JSON
 * const invalidLine = '{broken json}';
 * const invalidEvent = normalizeSnapshotEvent(invalidLine);
 * // → null
 *
 * // Контрольное сообщение
 * const pongLine = '{"event_type":"pong"}';
 * const pongEvent = normalizeSnapshotEvent(pongLine);
 * // → null
 * ```
 */
export function normalizeSnapshotEvent(line: string): DomainEvent | null {
  try {
    // 1. Парсим JSON
    const parsed = JSON.parse(line);

    // 2. Проверяем что это объект с event_type
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    if (typeof parsed.event_type !== 'string') {
      return null;
    }

    // 3. Используем существующий маппер
    // mapParsedToDomainEvent вернёт null для контрольных сообщений или невалидных данных
    return mapParsedToDomainEvent(parsed as any);
  } catch (error) {
    // JSON parse error → null
    return null;
  }
}
