/**
 * Domain/execution обработка завершила атомарную операцию над заявкой.
 *
 * @remarks
 * Это НЕ «площадка прислала ACCEPTED». Это более сильное утверждение:
 *
 * > операция уже посчитана и зафиксирована, вот итоговый `Order` и
 * > итоговый `Portfolio`, согласованные между собой.
 *
 * Поэтому одно событие представляет любой исход обработки:
 *
 * ```text
 * order created / accepted / partially filled
 * order cancelled / expired / rejected
 * ```
 *
 * Потребитель состояния НЕ решает, допустим ли переход `Order` — этим
 * владеет producer. Он проверяет согласованность идентичности и
 * материализует уже готовый итог.
 *
 * ### Почему `Order` и `Portfolio` идут ОДНИМ событием
 *
 * Постановка заявки резервирует деньги или токены, отмена — освобождает.
 * Разнести их на два события значило бы допустить окно, в котором состояние
 * видит новую заявку со старым портфелем (или наоборот) — то есть
 * неправильную свободную сумму ровно в тот момент, когда по ней принимается
 * следующее решение.
 *
 * ### Почему не Domain `OrderEvent`
 *
 * `ORDER_CREATED`/`ORDER_ACCEPTED`/… из `@polymarket/order-events` описывают
 * переход агрегата и НЕ несут портфель. Подписавшись на них, приватное
 * состояние получило бы заявку без гарантии, что соответствующий портфель уже
 * материализован.
 *
 * ### Producer
 *
 * Пока нет: будущий command/domain-процессор публикует это событие ПОСЛЕ
 * успешного commit'а операции.
 *
 * @example
 * ```typescript
 * const event = {
 *   type: 'TRADING_ACCOUNT_ORDER_COMMITTED',
 *   payload: { venueId, accountId, order, portfolio },
 *   metadata: metadataGenerator.nextChild(parentMetadata),
 * } satisfies TradingAccountOrderCommittedEvent;
 * ```
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { AccountId, VenueId } from '@polymarket/ids';
import type { Order } from '@polymarket/order';
import type { Portfolio } from '@polymarket/portfolio';

export type TradingAccountOrderCommittedEvent = MessageEnvelope<
  'TRADING_ACCOUNT_ORDER_COMMITTED',
  {
    /** Площадка аккаунта — обязательная часть его идентичности */
    readonly venueId: VenueId;
    /** Аккаунт-владелец заявки */
    readonly accountId: AccountId;
    /**
     * Заявка ПОСЛЕ операции — итоговое состояние, а не намерение.
     *
     * @remarks
     * `order.accountId` в новом торговом рантайме ОБЯЗАТЕЛЕН и обязан
     * совпадать с `accountId` payload. В самом `Order` поле остаётся
     * optional ради старых снапшотов — это отдельный будущий cleanup
     * домена, а не повод ослабить контракт приватного состояния.
     */
    readonly order: Order;
    /**
     * Портфель ПОСЛЕ той же операции.
     *
     * @remarks
     * Резервации под эту заявку уже учтены (или освобождены). Событие,
     * доставленное повторно, несёт УСТАРЕВШИЙ портфель — потребитель обязан
     * распознать дубликат по идентичности заявки и не применять его.
     */
    readonly portfolio: Portfolio;
  }
>;
