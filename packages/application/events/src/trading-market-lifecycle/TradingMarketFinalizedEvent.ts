/**
 * Торговый рантайм закончил всю работу по рынку.
 *
 * @remarks
 * Финализация — не удаление. После неё остаётся compact-состояние рынка:
 * canonical `Market`, времена жизненного цикла и (позже) ордера, филлы,
 * позиции, решения и итог. Тяжёлые ряды стакана и сделок к этому моменту уже
 * освобождены закрытием торговли.
 *
 * Выселение финализированных рынков из памяти появится вместе с durable
 * Market History — это отдельный этап, и предвосхищать его удалением
 * состояния здесь нельзя: сначала должно быть куда сохранить.
 *
 * `finalizedAt` — это `event.metadata.createdAt`.
 *
 * @example
 * ```typescript
 * const event = {
 *   type: 'TRADING_MARKET_FINALIZED',
 *   payload: { marketId },
 *   metadata: metadataGenerator.nextRoot(),
 * } satisfies TradingMarketFinalizedEvent;
 * ```
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { MarketId, VenueId } from '@polymarket/ids';

export type TradingMarketFinalizedEvent = MessageEnvelope<
  'TRADING_MARKET_FINALIZED',
  {
    /**
     * Площадка рынка — обязательная часть его идентичности.
     *
     * @remarks
     * `MarketId` уникален только внутри пространства имён своей площадки:
     * идентичность рынка — это ПАРА `venueId + marketId` (см. `Market.equals()`
     * и ключ `MarketUniverse`). Без площадки событие «активируй рынок X»
     * означало бы «активируй любой рынок с таким id», и рынок другой площадки
     * с совпавшим идентификатором получил бы наш переход.
     */
    readonly venueId: VenueId;
    /** Рынок, работа по которому завершена */
    readonly marketId: MarketId;
  }
>;
