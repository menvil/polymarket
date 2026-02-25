/**
 * FillSnapshot - плоское DTO для хранения/логов Fill
 *
 * @remarks
 * Сериализованное представление Fill entity в виде примитивов.
 * Используется для:
 * - Сохранения в хранилище (DB, Redis)
 * - Передачи между слоями (application → infrastructure)
 * - Логирования событий исполнения
 * - Восстановления через FillMapper.fromSnapshot()
 *
 * ### Отличие от Fill:
 * Fill использует value objects (Price, Quantity, Fee, Timestamp).
 * FillSnapshot использует только примитивы (number, string).
 * Это гарантирует совместимость с JSON.stringify() без потери данных.
 *
 * @example
 * ```typescript
 * // Получение снапшота из Fill
 * const snapshot = fill.toSnapshot();
 * const json = JSON.stringify(snapshot);
 *
 * // Восстановление из снапшота
 * const result = FillMapper.fromSnapshot(snapshot);
 * if (result.ok) {
 *   const restored = result.value;
 * }
 * ```
 */
export interface FillSnapshot {
  /** Уникальный ID исполнения */
  readonly id: string;
  /** ID ордера (обязателен) */
  readonly orderId: string;
  /** ID аккаунта */
  readonly accountId: string;
  /** ID торговой площадки */
  readonly venueId: string;
  /** ID рынка */
  readonly marketId: string;
  /** ID токена (актива) — JSON сериализованный AssetId */
  readonly tokenId: string;
  /** Цена исполнения */
  readonly price: number;
  /** Размер исполнения */
  readonly size: number;
  /** Сторона (BUY/SELL) */
  readonly side: 'BUY' | 'SELL';
  /** Время исполнения в epoch milliseconds */
  readonly timestampMs: number;
  /** Fee amount */
  readonly feeAmount: number;
  /** Fee asset (JSON сериализованный AssetId) */
  readonly feeAsset: string;
  /** Тип ликвидности (MAKER/TAKER) — опционально */
  readonly liquidity?: 'MAKER' | 'TAKER';
  /** ID трейда на venue — опциональная сшивка с Trade entity */
  readonly venueTradeId?: string;
}
