/**
 * Доменные события — связанные с исполнением ордеров.
 *
 * @remarks
 * FILL_RECEIVED публикуется FillEventHandler после успешного маппинга Fill.
 * Используется FillOrchestrator для запуска ProcessFillUseCase.
 */
import type { Fill } from '@polymarket/fill';
import type { Timestamp } from '@polymarket/value-objects';

/**
 * Fill (исполнение ордера) получен из user-channel Polymarket WS.
 *
 * @remarks
 * Публикуется FillEventHandler.handle() после маппинга WsUserFillDto → Fill.
 * FillOrchestrator подписывается и запускает ProcessFillUseCase.
 */
export interface FillReceivedEvent {
  readonly type: 'FILL_RECEIVED';
  /** Типизированный Fill domain record */
  readonly fill: Fill;
  /** Timestamp получения события в системе */
  readonly receivedAt: Timestamp;
}
