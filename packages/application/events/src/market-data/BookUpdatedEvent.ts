/**
 * Высокочастотное событие — каждое изменение лучшей цены стакана.
 *
 * @remarks
 * Несёт {@link TopOfBook} (immutable snapshot O(1)), а НЕ mutable OrderBook.
 * Стратегии подписываются через TradingAPI.subscribe('BOOK_UPDATED', cb).
 *
 * ### Идентичность повторяет Domain
 *
 * `venueId` / `marketId?` / `instrumentId` — те же три поля и с той же
 * семантикой, что у `Orderbook`. Раньше `marketId` был ОБЯЗАТЕЛЬНЫМ и
 * документировался как condition_id, а `venueId` отсутствовал вовсе:
 * контракт события противоречил сущности, которую описывал, и делал
 * биржевой стакан непредставимым.
 *
 * ### Параметризация ценовым доменом
 *
 * `TPrice` позволяет нести верхушку и prediction-книги, и биржевой.
 * Default `OutcomePrice` сохраняет существующие сигнатуры.
 *
 * Canonical envelope `{ type, payload, metadata }` (M-003).
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { InstrumentId, MarketId, VenueId } from '@polymarket/ids';
import type { DecimalPrice, OutcomePrice } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';
import type { TopOfBook } from './TopOfBook.js';

export type BookUpdatedEvent<TPrice extends DecimalPrice = OutcomePrice> = MessageEnvelope<
  'BOOK_UPDATED',
  {
    /** Верхушка стакана — лучшие bid/ask */
    readonly topOfBook: TopOfBook<TPrice>;
    /** Площадка, которой принадлежит стакан. */
    readonly venueId: VenueId;
    /** Рынок (condition_id), если он есть отдельно от инструмента. */
    readonly marketId?: MarketId;
    /** Торгуемый инструмент: outcome-токен либо символ пары. */
    readonly instrumentId: InstrumentId;
    /**
     * Монотонно возрастающий номер снапшота — для gap detection.
     *
     * @remarks
     * Per-instrument semantic-версия, а не глобальная последовательность
     * шины: та содержит сообщения других инструментов и имеет у одного
     * инструмента естественные «дыры», неотличимые от потерь.
     */
    readonly sequenceNumber: number;
    /** Timestamp снапшота */
    readonly timestamp: Timestamp;
  }
>;
