/**
 * Площадка сообщила новый статус исполнения — БЕЗ изменения экономики.
 *
 * @remarks
 * У исполнения две независимые оси, и это событие про вторую:
 *
 * ```text
 * что сделали МЫ           APPLIED → CONFIRMED | REVERTED   AccountFillStatus
 * что говорит ПЛОЩАДКА     MATCHED → MINED → CONFIRMED      TradeStatus
 *                                 ↘ RETRYING ↘ FAILED
 * ```
 *
 * Оси нельзя схлопнуть в одну. `MATCHED` — исполнение сматчено матчером
 * Polymarket (off-chain); `MINED` — расчётная транзакция включена в блок
 * Polygon. Это утверждения о РАЗНЫХ системах, и различие между ними —
 * реальная разница в риске отката, а не оформление.
 *
 * С другой стороны, `REVERTED` — это НАШЕ действие, а `FAILED` — наблюдение
 * площадки, и совпадают они не всегда: сверка (#98) откатит исполнение,
 * которого на площадке не оказалось вовсе, и никакого `TradeStatus` за таким
 * откатом не стоит.
 *
 * ### Зачем отдельное событие
 *
 * `MATCHED`, `CONFIRMED` и `FAILED` имеют экономических «двойников»
 * (`FILL_APPLIED`, `FILL_CONFIRMED`, `FILL_REVERTED`). А `MINED` и `RETRYING`
 * не меняют ни портфель, ни заявку — им ехать не на чем. Без этого события
 * они просто терялись бы.
 *
 * Экономические события venue-ось НЕ трогают: смешав их, мы получили бы ровно
 * то схлопывание, ради предотвращения которого оси и разделены. Producer,
 * наблюдающий `MATCHED`, публикует ДВА события — «площадка сматчила» и
 * «экономика применена». Это два разных факта.
 *
 * ### Почему `TradeStatus`, а не свой enum
 *
 * `TradeStatus` уже существует в `@polymarket/fill` как канонический контракт
 * on-chain статуса Polymarket, и `ExecutionMetadata.tradeStatus` — его
 * штатный носитель. Заводить рядом второй набор тех же пяти строк значило бы
 * получить третью копию (`VenueTradeStatus` в `@polymarket/ports` — уже
 * вторая).
 *
 * Поле опционально в записи состояния: площадка без on-chain расчётов такого
 * статуса не сообщает вовсе, и это норма, а не пропуск.
 *
 * @example
 * ```typescript
 * const event = {
 *   type: 'TRADING_ACCOUNT_FILL_VENUE_STATUS_OBSERVED',
 *   payload: { fill, venueStatus: 'MINED' },
 *   metadata: metadataGenerator.nextChild(parentMetadata),
 * } satisfies TradingAccountFillVenueStatusObservedEvent;
 * ```
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { Fill, TradeStatus } from '@polymarket/fill';

export type TradingAccountFillVenueStatusObservedEvent = MessageEnvelope<
  'TRADING_ACCOUNT_FILL_VENUE_STATUS_OBSERVED',
  {
    /**
     * Тот же immutable факт исполнения, что был применён.
     *
     * @remarks
     * Несёт `venueId`/`accountId`, поэтому маршрутизация берётся из него — как
     * и у остальных fill-событий контура.
     */
    readonly fill: Fill;
    /**
     * Статус, о котором сообщила площадка.
     *
     * @remarks
     * Обязателен: событие существует ровно затем, чтобы его донести.
     * В записи состояния соответствующее поле опционально — там `undefined`
     * означает «площадка ничего не сообщала».
     */
    readonly venueStatus: TradeStatus;
  }
>;
