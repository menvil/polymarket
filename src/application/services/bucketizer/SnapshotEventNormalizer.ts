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
 * Normalize a raw JSONL snapshot line into a DomainEvent or return null for non-data or invalid lines.
 *
 * @param line - A single JSONL string read from a snapshot file representing an event.
 * @returns A DomainEvent when the line contains a valid data event; `null` for invalid JSON, missing or non-string `event_type`, or control/non-data messages.
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