/**
 * Fill (исполнение ордера) первично обработан (WsFillStatus: MATCHED).
 *
 * @remarks
 * Публикуется FillEventHandler при получении fill со статусом MATCHED.
 * FillOrchestrator подписывается и запускает ProcessFillUseCase.
 */
import type { Fill } from '@polymarket/fill';
import type { Timestamp } from '@polymarket/value-objects';

export interface FillReceivedEvent {
  readonly type: 'FILL_RECEIVED';
  /** Типизированный Fill domain record */
  readonly fill: Fill;
  /** Timestamp получения события в системе */
  readonly receivedAt: Timestamp;
}
