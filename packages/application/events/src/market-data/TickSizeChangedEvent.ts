/**
 * Venue изменил шаг цены (tick size) инструмента.
 *
 * @remarks
 * Tick size определяет, какие цены вообще ПРЕДСТАВИМЫ в стакане и какие
 * лимитные цены venue примет. Его изменение — не диагностика, а вход
 * последующего execution: ордер, выставленный по старому шагу, будет
 * отвергнут. Поэтому событие canonical, а не лог.
 *
 * ### Почему `OutcomePrice`, а не отдельный `TickSize` VO
 *
 * Шаг цены — величина ТОГО ЖЕ домена, что и цена outcome-токена
 * (`0.01`/`0.001`/`0.0001`), и он обязан быть кратен базовому тику
 * `OutcomePrice.MIN`. Правила проверки шага уже живут в модуле `OutcomePrice`
 * (`ValidateTickSize`, `ValidateTickSizeMultipleOfBaseTick`), поэтому
 * заводить второй тип для того же домена значило бы раздвоить инвариант.
 * Lifecycle/бизнес-логики у tick size нет — сущностью он не является.
 *
 * ### Идентичность
 *
 * `venueId` + `marketId` + `instrumentId` — та же полная идентичность, что у
 * остальных market-data событий. Событие всегда market-scoped: шаг цены —
 * свойство рынка предсказаний, а не общей ленты площадки, поэтому `marketId`
 * здесь обязателен (в отличие от `BOOK_DEPTH`, где он опционален).
 *
 * ### `oldTickSize` опционален
 *
 * Vendor не гарантирует предыдущее значение (в SDK-контракте
 * `old_tick_size` nullable/optional). Отсутствие означает «venue не
 * сообщил прежний шаг», и выдумывать его нельзя.
 *
 * Canonical envelope `{ type, payload, metadata }` (M-003).
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { InstrumentId, MarketId, VenueId } from '@polymarket/ids';
import type { OutcomePrice } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';

export type TickSizeChangedEvent = MessageEnvelope<
  'TICK_SIZE_CHANGED',
  {
    /**
     * Площадка — первая часть идентичности рынка и инструмента.
     *
     * @remarks
     * Остальные market-data события (`BOOK_UPDATED`, `BOOK_DEPTH`,
     * `TRADE_RECEIVED`) несут `venueId` с самого начала; здесь он появился
     * позже — и это была дыра, а не экономия. `MarketId` и `InstrumentId`
     * уникальны только внутри пространства имён своей площадки, поэтому без
     * `venueId` событие не адресует ничего однозначно: потребитель, который
     * держит рынки нескольких площадок, применил бы смену шага к чужому
     * инструменту с совпавшим идентификатором.
     */
    readonly venueId: VenueId;
    /** ID рынка (condition_id) */
    readonly marketId: MarketId;
    /** ID токена (UP/DOWN outcome token) */
    readonly instrumentId: InstrumentId;
    /** Прежний шаг цены — `undefined`, если venue его не сообщил */
    readonly oldTickSize: OutcomePrice | undefined;
    /** Новый шаг цены */
    readonly newTickSize: OutcomePrice;
    /** Timestamp изменения */
    readonly timestamp: Timestamp;
  }
>;
