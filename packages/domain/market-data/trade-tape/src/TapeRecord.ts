/**
 * Запись трейда в ленте (TapeRecord)
 *
 * @remarks
 * Минимальный набор полей доступных из WS-ленты трейдов.
 * Не является полным `Trade` entity — не содержит `VenueTradeId`, `VenueId`, `AssetId`.
 * Хранит только то, что реально приходит из потока рыночных данных.
 *
 * Используется в:
 * - `TradeTape` — append-only хранилище записей
 * - `TradeFlowCalculator` — вычисление VWAP, OFI, объёмов
 */

import type { OutcomePrice, Quantity, Side } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';

/**
 * Минимальная запись трейда из WS-ленты
 *
 * @example
 * ```typescript
 * const record: TapeRecord = {
 *   price,
 *   size,
 *   side: 'BUY',
 *   timestamp,
 * };
 * tape.append(record);
 * ```
 */
export interface TapeRecord {
  /** Цена исполнения (OutcomePrice VO) */
  readonly price: OutcomePrice;
  /** Объём трейда (Quantity VO) */
  readonly size: Quantity;
  /**
   * Сторона агрессора.
   * undefined — нет информации о стороне (исключается из OFI, но входит в VWAP).
   */
  readonly side: Side | undefined;
  /** Временная метка трейда в мс */
  readonly timestamp: Timestamp;
}

/**
 * Политика хранения записей в ленте
 *
 * @remarks
 * Хотя бы одно поле должно быть задано.
 */
export interface TapeRetentionPolicy {
  /**
   * Максимальное количество записей.
   * При превышении самая старая запись вытесняется (FIFO).
   */
  readonly maxCount?: number;
  /**
   * Максимальный возраст записи в мс.
   * Устаревшие вытесняются при каждом `append()`.
   */
  readonly maxAgeMs?: number;
}
