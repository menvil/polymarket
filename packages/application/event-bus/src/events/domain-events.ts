/**
 * Доменные события — связанные с исполнением ордеров из user-channel Polymarket WS.
 *
 * @remarks
 * Жизненный цикл fill в user channel (WsFillStatus):
 * - MATCHED    → публикуем FILL_RECEIVED (primary trigger для ProcessFillUseCase)
 * - MINED      → on-chain confirmation, опционально логировать
 * - CONFIRMED  → finality, опционально обновить запись
 * - RETRYING   → alert о проблеме с транзакцией
 * - FAILED     → публикуем FILL_FAILED (требует reconciliation)
 *
 * FillEventHandler проверяет WsFillStatus и публикует соответствующее событие.
 */
import type { Fill } from '@polymarket/fill';
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
export interface FillFailedEvent {
  readonly type: 'FILL_FAILED';
  /** ID fail-события (совпадает с WsUserFillDto.id для трассировки) */
  readonly fillId: string;
  /** ID связанного ордера (taker_order_id из WsUserFillDto) */
  readonly orderId: string;
  /** Timestamp получения события в системе */
  readonly receivedAt: Timestamp;
}
