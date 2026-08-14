/**
 * Fill (исполнение ордера) первично обработан (WsFillStatus: MATCHED).
 *
 * @remarks
 * Публикуется FillEventHandler при получении fill со статусом MATCHED.
 * FillOrchestrator подписывается и запускает ProcessFillUseCase, передавая
 * `event.metadata` как parent порождаемых сообщений (causal chain).
 *
 * Canonical envelope `{ type, payload, metadata }` (M-003): root-событие
 * контура — первичная реакция на внешнее наблюдение, metadata создаётся
 * `metadataGenerator.nextRoot()`.
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { Fill } from '@polymarket/fill';
import type { Timestamp } from '@polymarket/timestamp';

export type FillReceivedEvent = MessageEnvelope<
  'FILL_RECEIVED',
  {
    /** Типизированный Fill domain record */
    readonly fill: Fill;
    /** Timestamp получения события в системе */
    readonly receivedAt: Timestamp;
  }
>;
