/**
 * Ранее применённое исполнение откачено, экономика пересчитана.
 *
 * @remarks
 * Площадка может отменить исполнение до финальности: транзакция не прошла,
 * матч распался. Тогда применённый эффект обязан быть снят.
 *
 * Расчёт отката делает upstream (domain/recovery), а не потребитель
 * состояния: payload несёт УЖЕ пересчитанный портфель и — если она
 * изменилась — заявку. Считать реверс в проекции значило бы держать вторую
 * реализацию экономики рядом с первой.
 *
 * ### Допустимый переход только один
 *
 * ```text
 * APPLIED → REVERTED     да
 * CONFIRMED → REVERTED   нет
 * ```
 *
 * `CONFIRMED` означает финальность. Если площадка когда-нибудь отменит
 * финализированное исполнение, это будет отдельный явный recovery-контракт с
 * собственным событием и собственными проверками — а не тихий переход,
 * встроенный «на всякий случай».
 *
 * @example
 * ```typescript
 * const event = {
 *   type: 'TRADING_ACCOUNT_FILL_REVERTED',
 *   payload: { fill, portfolio, order, reason: 'venue reported FAILED' },
 *   metadata: metadataGenerator.nextChild(parentMetadata),
 * } satisfies TradingAccountFillRevertedEvent;
 * ```
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { Fill } from '@polymarket/fill';
import type { Order } from '@polymarket/order';
import type { Portfolio } from '@polymarket/portfolio';

export type TradingAccountFillRevertedEvent = MessageEnvelope<
  'TRADING_ACCOUNT_FILL_REVERTED',
  {
    /** Тот же immutable факт исполнения, что был применён */
    readonly fill: Fill;
    /** Портфель ПОСЛЕ отката экономики этого исполнения */
    readonly portfolio: Portfolio;
    /**
     * Заявка ПОСЛЕ отката, если она изменилась.
     *
     * @remarks
     * Те же правила связи с `Fill`, что и в
     * `TRADING_ACCOUNT_FILL_APPLIED`.
     */
    readonly order?: Order;
    /**
     * Причина отката — свободный текст для диагностики.
     *
     * @remarks
     * Не enum: реальных producer-ов ещё нет, и угаданный набор причин
     * оказался бы либо неполным, либо мёртвым. Ни одно решение рантайма на
     * это поле не смотрит — оно попадает в запись отката и в лог.
     */
    readonly reason: string;
  }
>;
