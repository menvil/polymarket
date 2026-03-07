/**
 * TradeSnapshot - плоское DTO для хранения/логов Trade
 *
 * @remarks
 * Сериализованное представление Trade entity в виде примитивов.
 * Используется для:
 * - Сохранения в хранилище (DB, Redis)
 * - Передачи между слоями (application → infrastructure)
 * - Логирования событий
 * - Восстановления через TradeMapper.fromSnapshot()
 *
 * ### Отличие от Trade:
 * Trade использует value objects (Price, Quantity, Timestamp).
 * TradeSnapshot использует только примитивы (string, number).
 * Числовые поля (price, size) сериализуются через Decimal.toString() — строковое
 * представление сохраняет полную точность Decimal без потерь IEEE 754.
 *
 * @example
 * ```typescript
 * // Получение снапшота из Trade
 * const snapshot = trade.toSnapshot();
 * const json = JSON.stringify(snapshot);
 *
 * // Восстановление из снапшота
 * const result = TradeMapper.fromSnapshot(snapshot);
 * if (result.ok) {
 *   const restored = result.value;
 * }
 * ```
 */
export interface TradeSnapshot {
  /** Уникальный ID трейда на venue */
  readonly id: string;
  /** ID торговой площадки */
  readonly venueId: string;
  /** ID рынка */
  readonly marketId: string;
  /** ID токена (актива) */
  readonly tokenId: string;
  /** Цена трейда (строка для точного хранения Decimal) */
  readonly price: string;
  /** Размер трейда (строка для точного хранения Decimal) */
  readonly size: string;
  /** Сторона агрессора (BUY/SELL) — опционально, не всегда известно */
  readonly aggressorSide?: 'BUY' | 'SELL';
  /** Время трейда в epoch milliseconds */
  readonly timestampMs: number;
  /** Хэш блокчейн-транзакции — опционально */
  readonly txHash?: string;
}
