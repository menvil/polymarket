/**
 * Доменные события — связанные с исполнением ордеров из user-channel Polymarket WS.
 *
 * @remarks
 * Жизненный цикл fill в user channel (WsFillStatus):
 * - MATCHED    → публикуем FILL_RECEIVED (primary trigger для ProcessFillUseCase)
 *                Portfolio обновляется немедленно. SELL может быть отклонён CLOB
 *                для cross-outcome mint — retry на следующем тике.
 * - MINED      → логируем, ждём finality
 * - CONFIRMED  → fallback: если MATCHED был пропущен (рестарт бота), публикуем FILL_RECEIVED.
 *                Иначе — idempotency guard в ProcessFillUseCase отбросит.
 * - RETRYING   → alert о проблеме с транзакцией
 * - FAILED     → публикуем FILL_FAILED с fills для отката Portfolio
 *
 * FillEventHandler проверяет WsFillStatus и публикует соответствующее событие.
 */
import type { Fill } from '@polymarket/fill';
import type { FillId, OrderId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';

/**
 * Fill (исполнение ордера) первично обработан (WsFillStatus: MATCHED).
 *
 * @remarks
 * Публикуется FillEventHandler при получении fill со статусом MATCHED.
 * FillOrchestrator подписывается и запускает ProcessFillUseCase.
 */
export interface FillReceivedEvent {
  readonly type: 'FILL_RECEIVED';
  /** Типизированный Fill domain record */
  readonly fill: Fill;
  /** Timestamp получения события в системе */
  readonly receivedAt: Timestamp;
}

/**
 * Fill окончательно упал (WsFillStatus: FAILED).
 *
 * @remarks
 * Публикуется FillEventHandler при получении fill со статусом FAILED.
 * Требует reconciliation: ранее записанный fill нужно откатить или пометить как failed.
 * RiskOrchestrator и RecoveryService подписываются на это событие.
 *
 * @example
 * ```typescript
 * eventBus.subscribe('FILL_FAILED', async (event) => {
 *   logger.error('Fill failed, triggering reconciliation', {
 *     fillId: event.fillId,
 *     orderId: event.orderId,
 *   });
 *   await reconciliationService.handleFailedFill(event.fillId);
 * });
 * ```
 */
/**
 * Fill подтверждён on-chain (WsFillStatus: CONFIRMED) после обработки при MATCHED.
 *
 * @remarks
 * Публикуется FillEventHandler когда CONFIRMED приходит для уже опубликованного fill.
 * Сигнализирует что on-chain settlement завершён:
 * - Токены доступны для SELL (cross-outcome mint finality)
 * - Exchange rejection cooldown можно сбросить
 * - Стратегия должна тикнуть для retry SELL
 *
 * НЕ публикуется при fallback (CONFIRMED без MATCHED) — там идёт FILL_RECEIVED.
 */
export interface FillConfirmedEvent {
  readonly type: 'FILL_CONFIRMED';
  /** Fills, подтверждённые on-chain */
  readonly fills: readonly Fill[];
  /** Timestamp получения CONFIRMED в системе */
  readonly receivedAt: Timestamp;
}

export interface FillFailedEvent {
  readonly type: 'FILL_FAILED';
  /** ID fail-события (совпадает с WsUserFillDto.id для трассировки) */
  readonly fillId: FillId;
  /** ID связанного ордера (taker_order_id из WsUserFillDto) */
  readonly orderId: OrderId;
  /** Timestamp получения события в системе */
  readonly receivedAt: Timestamp;
  /**
   * Fills, закэшированные при MATCHED и требующие отката Portfolio.
   *
   * @remarks
   * Доступны только если MATCHED предшествовал FAILED (нормальный flow).
   * При рестарте бота между MATCHED и FAILED — undefined, откат невозможен,
   * требуется ручная reconciliation.
   */
  readonly fills?: readonly Fill[];
}
