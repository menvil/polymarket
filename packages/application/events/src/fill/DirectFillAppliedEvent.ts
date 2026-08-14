/**
 * Fill применён напрямую к портфелю (ордер не найден или уже terminal).
 *
 * @remarks
 * Публикуется ProcessFillUseCase когда fill приходит для ордера в terminal
 * статусе (CANCELLED/FILLED) или когда ордер не найден (рестарт бота,
 * внешний/ручной ордер).
 *
 * Используется MarketRotation для учёта таких fills в fillHistory:
 * без этого события рынок не видит fill и не считает его в сводке.
 *
 * ### Когда возникает:
 * - Стратегия отменила ордер локально (REST CANCEL), но exchange уже
 *   MATCHED — fill приходит по WS на CANCELLED ордер.
 * - Reconciliation обнаружила fill для ордера, которого нет в репозитории.
 * - Внешний/ручной ордер, не созданный ботом.
 *
 * Canonical envelope `{ type, payload, metadata }` (M-003): порождается
 * обработкой FILL_RECEIVED, поэтому metadata — `nextChild(parent.metadata)`
 * (наследует causal chain fill-события).
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { Fill } from '@polymarket/fill';

export type DirectFillAppliedEvent = MessageEnvelope<
  'DIRECT_FILL_APPLIED',
  {
    /** Fill, применённый напрямую без order-entity */
    readonly fill: Fill;
  }
>;
