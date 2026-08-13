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
import type { Fill } from '@polymarket/fill';
import type { FillId, OrderId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';

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
