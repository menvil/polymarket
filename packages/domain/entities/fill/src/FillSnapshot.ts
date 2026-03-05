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
 * Это обеспечивает совместимость с JSON.stringify(), однако числа (price, size, feeAmount)
 * хранятся как number — при экстремальных значениях возможна потеря точности Decimal.
 * Для высокоточных требований рекомендуется сериализовать числа как строки.
 *
 * ### Инфраструктурные метаданные:
 * liquidity и venueTradeId хранятся в снапшоте как опциональные поля
 * (часть ExecutionMetadata). Они не влияют на доменную экономику Fill,
 * но нужны для восстановления полного контекста исполнения.
 *
 * @example
 * ```typescript
 * // Сохранение Fill + metadata в снапшот
 * const snapshot = FillMapper.toSnapshot(fill, metadata);
 * const json = JSON.stringify(snapshot);
 *
 * // Восстановление из снапшота
 * const result = FillMapper.fromSnapshot(snapshot);
 * if (result.ok) {
 *   const { fill, metadata } = result.value;
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
  /** Расчётный актив — JSON сериализованный AssetId (USDC для Polymarket) */
  readonly settlementAssetId: string;
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
  /** Тип ликвидности (MAKER/TAKER) — опциональные метаданные */
  readonly liquidity?: 'MAKER' | 'TAKER';
  /** ID трейда на venue — опциональная сшивка с Trade entity */
  readonly venueTradeId?: string;
  /** On-chain статус трейда из Polymarket user-channel события */
  readonly tradeStatus?: string;
}
