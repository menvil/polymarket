/**
 * Низкочастотное событие — полный стакан по запросу или раз в N ms.
 *
 * @remarks
 * Несёт сам `Orderbook` (`@polymarket/orderbook`) — иммутабельную entity,
 * безопасную для fanout-рассылки нескольким стратегиям без риска, что одна
 * увидит мутацию другой (в отличие от старого mutable `OrderBook`, ради
 * которого раньше строился отдельный `OrderBookSnapshot`-DTO).
 *
 * ### Идентичность повторяет Domain
 *
 * `venueId` / `marketId?` / `instrumentId` — те же три поля и с той же
 * семантикой, что у `Orderbook`. Раньше событие несло только
 * `instrumentId`, из-за чего площадка терялась, а книги одного символа на
 * разных биржах были неразличимы. `marketId` опционален по той же причине,
 * что и в сущности: у биржи рынок не существует отдельно от инструмента.
 *
 * ### Параметризация ценовым доменом
 *
 * `TPrice` позволяет одному и тому же событию нести и стакан рынка
 * предсказаний, и стакан биржи. Без этого Application-граница осталась бы
 * prediction-specific, и CEX-адаптеру пришлось бы заводить второй тип
 * события — то есть та же стена, только слоем выше.
 *
 * Canonical envelope `{ type, payload, metadata }` (M-003).
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { Orderbook } from '@polymarket/orderbook';
import type { InstrumentId, MarketId, VenueId } from '@polymarket/ids';
import type { DecimalPrice, OutcomePrice } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';

export type BookDepthEvent<TPrice extends DecimalPrice = OutcomePrice> = MessageEnvelope<
  'BOOK_DEPTH',
  {
    /** Площадка, которой принадлежит стакан. */
    readonly venueId: VenueId;
    /** Рынок (condition_id), если он есть отдельно от инструмента. */
    readonly marketId?: MarketId;
    /** Торгуемый инструмент: outcome-токен либо символ пары. */
    readonly instrumentId: InstrumentId;
    /** Полный стакан — иммутабельная entity, не DTO */
    readonly snapshot: Orderbook<TPrice>;
    /** Timestamp снапшота */
    readonly timestamp: Timestamp;
  }
>;
